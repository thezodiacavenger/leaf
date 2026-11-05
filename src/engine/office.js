// Windows bridge to the Office apps the user already has, via PowerShell + COM.
// Word does the PDF export (perfect fidelity); classic Outlook composes mail.
// New Outlook (the web-based one) has no COM API, so we fall back to mailto / revealing the files.
const { execFile } = require('node:child_process');
const { shell } = require('electron');

const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // PowerShell single-quote escaping

function ps(script, timeout = 120000) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('needs Windows'));
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout, windowsHide: true }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n')[0])) : resolve(stdout.trim())));
  });
}

const WORD_OPEN = (src) => `
$ErrorActionPreference='Stop'
$w = New-Object -ComObject Word.Application; $w.Visible = $false; $w.DisplayAlerts = 0
try { $d = $w.Documents.Open(${q(src)}, $false, $true)`;
const WORD_CLOSE = `} finally { if ($d) { $d.Close($false) }; $w.Quit() }`;

async function docToPdf(src, dest) {
  await ps(`${WORD_OPEN(src)}; $d.ExportAsFixedFormat(${q(dest)}, 17) ${WORD_CLOSE}`);
}

// Copies the whole document (tables, styles, images) into a fresh Outlook message body, above the signature.
async function docToMail(src) {
  await ps(`${WORD_OPEN(src)}
  $d.Content.Copy()
  $o = New-Object -ComObject Outlook.Application
  $m = $o.CreateItem(0); $m.Subject = [IO.Path]::GetFileNameWithoutExtension(${q(src)}); $m.Display()
  $m.GetInspector.WordEditor.Range(0,0).Paste()
  ${WORD_CLOSE}`);
}

async function composeMail({ attachments = [], subject = '' }) {
  const list = attachments.map(q).join(',');
  try {
    await ps(`$ErrorActionPreference='Stop'
$o = New-Object -ComObject Outlook.Application; $m = $o.CreateItem(0); $m.Subject = ${q(subject)}
foreach ($f in @(${list})) { [void]$m.Attachments.Add($f) }; $m.Display()`);
    return { via: 'outlook' };
  } catch {
    // No classic Outlook: reveal the files so they can be dragged into any mail app, and open a blank draft.
    if (attachments[0]) shell.showItemInFolder(attachments[0]);
    shell.openExternal(`mailto:?subject=${encodeURIComponent(subject)}`);
    return { via: 'fallback' };
  }
}

module.exports = { docToPdf, docToMail, composeMail };
