// Windows bridge to the Office apps the user already has, via Windows PowerShell + COM.
// Office does the conversions, so layout fidelity is exact. Batches share one PowerShell session and one
// instance of each app (starting Word/Excel costs seconds). New Outlook has no COM API -> mail falls back.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { shell } = require('electron');

const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // PowerShell single-quote escaping
const isWin = process.platform === 'win32';

function ps(script, timeout = 300000) {
  return new Promise((resolve, reject) => {
    if (!isWin) return reject(new Error('needs Windows with Microsoft Office'));
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n')[0])) : resolve(stdout.trim())));
  });
}

const KIND = { '.doc': 'word', '.docx': 'word', '.docm': 'word', '.rtf': 'word', '.odt': 'word', '.xls': 'excel', '.xlsx': 'excel', '.xlsm': 'excel', '.xlsb': 'excel', '.ods': 'excel', '.ppt': 'ppt', '.pptx': 'ppt', '.pptm': 'ppt', '.odp': 'ppt' };
const appFor = (file) => KIND[path.extname(file).toLowerCase()];

// One script handles a whole list of jobs. Each job: { op, src, dest }.
// ops: pdf (any Office file -> PDF; Excel fitted to page width), pdf2word, csv (one CSV per sheet into dest folder), clean.
const SCRIPT = (jobsFile, outFile) => `
$ErrorActionPreference = 'Stop'
$jobs = Get-Content -Raw -Encoding UTF8 ${q(jobsFile)} | ConvertFrom-Json
$word = $null; $excel = $null; $ppt = $null; $pptHad = 0; $res = @()
function W { if (-not $script:word) { $script:word = New-Object -ComObject Word.Application; $script:word.Visible = $false; $script:word.DisplayAlerts = 0 }; $script:word }
function X { if (-not $script:excel) { $script:excel = New-Object -ComObject Excel.Application; $script:excel.Visible = $false; $script:excel.DisplayAlerts = $false; $script:excel.ScreenUpdating = $false }; $script:excel }
function P { if (-not $script:ppt) { $script:ppt = New-Object -ComObject PowerPoint.Application; $script:pptHad = $script:ppt.Presentations.Count }; $script:ppt }
foreach ($j in $jobs) {
  try {
    switch ($j.op) {
      'pdf' {
        switch ($j.app) {
          'word'  { $d = (W).Documents.Open($j.src, $false, $true); try { $d.ExportAsFixedFormat($j.dest, 17) } finally { $d.Close($false) } }
          'excel' {
            $x = X; $wb = $x.Workbooks.Open($j.src, 0, $true)
            try {
              try { $x.PrintCommunication = $false } catch {}
              foreach ($ws in $wb.Worksheets) { try { $ps = $ws.PageSetup; $ps.Zoom = $false; $ps.FitToPagesWide = 1; $ps.FitToPagesTall = $false; if ($ws.UsedRange.Columns.Count -gt 8) { $ps.Orientation = 2 } } catch {} }
              try { $x.PrintCommunication = $true } catch {}
              $wb.ExportAsFixedFormat(0, $j.dest)
            } finally { $wb.Close($false) }
          }
          'ppt'   { $p = (P).Presentations.Open($j.src, -1, 0, 0); try { $p.SaveAs($j.dest, 32) } finally { $p.Close() } }
        }
      }
      'pdf2word' { $d = (W).Documents.Open($j.src, $false, $true); try { $d.SaveAs2($j.dest, 16) } finally { $d.Close($false) } }
      'csv' {
        $x = X; $wb = $x.Workbooks.Open($j.src, 0, $true); $n = 0
        try {
          New-Item -ItemType Directory -Force -Path $j.dest | Out-Null
          foreach ($ws in $wb.Worksheets) {
            if ($ws.UsedRange.Cells.Count -le 1 -and -not $ws.UsedRange.Value2) { continue }
            $ws.Copy(); $nb = $x.ActiveWorkbook
            $name = ($ws.Name -replace '[\\\\/:*?"<>|]', ' ').Trim(); $out = Join-Path $j.dest ($name + '.csv')
            try { $nb.SaveAs($out, 62) } finally { $nb.Close($false) }; $n++
          }
        } finally { $wb.Close($false) }
      }
      'clean' {
        Copy-Item -LiteralPath $j.src -Destination $j.dest -Force
        switch ($j.app) {
          'word'  { $d = (W).Documents.Open($j.dest); try { $d.RemoveDocumentInformation(99); $d.Save() } finally { $d.Close($false) } }
          'excel' { $wb = (X).Workbooks.Open($j.dest); try { $wb.RemoveDocumentInformation(99); $wb.Save() } finally { $wb.Close($false) } }
          'ppt'   { $p = (P).Presentations.Open($j.dest, 0, 0, 0); try { $p.RemoveDocumentInformation(99); $p.Save() } finally { $p.Close() } }
        }
      }
    }
    $res += @{ i = $j.i; ok = $true }
  } catch { $res += @{ i = $j.i; ok = $false; err = $_.Exception.Message } }
}
if ($word) { $word.Quit() }
if ($excel) { $excel.Quit() }
if ($ppt -and $ppt.Presentations.Count -eq 0 -and $pptHad -eq 0) { $ppt.Quit() }
[IO.File]::WriteAllText(${q(outFile)}, (ConvertTo-Json -InputObject @($res) -Compress), [Text.Encoding]::UTF8)
`;

// jobs: [{ op, src, dest }] -> [{ ok, err }] in the same order.
async function runJobs(jobs) {
  if (!jobs.length) return [];
  if (!isWin) return jobs.map(() => ({ ok: false, err: 'needs Windows with Microsoft Office' }));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'leaf-office-'));
  const jf = path.join(dir, 'jobs.json'); const of = path.join(dir, 'out.json');
  await fsp.writeFile(jf, JSON.stringify(jobs.map((j, i) => ({ ...j, i, app: j.app || appFor(j.src) }))), 'utf8');
  try {
    await ps(SCRIPT(jf, of), Math.max(120000, jobs.length * 90000));
    const res = JSON.parse((await fsp.readFile(of, 'utf8')).replace(/^﻿/, ''));
    return jobs.map((_, i) => { const r = res.find((x) => x.i === i); return r ? { ok: !!r.ok, err: r.err } : { ok: false, err: 'not converted' }; });
  } catch (e) {
    const msg = /ComObject|80040154|class not registered/i.test(e.message) ? 'Microsoft Office isn’t installed on this PC' : e.message;
    return jobs.map(() => ({ ok: false, err: msg }));
  } finally { fs.rm(dir, { recursive: true, force: true }, () => {}); }
}

async function toPdf(src, dest) { const [r] = await runJobs([{ op: 'pdf', src, dest }]); if (!r.ok) throw new Error(r.err); }
const docToPdf = toPdf;

// Copies the whole document (tables, styles, images) into a fresh Outlook message body, above the signature.
async function docToMail(src) {
  await ps(`$ErrorActionPreference='Stop'
$w = New-Object -ComObject Word.Application; $w.Visible = $false; $w.DisplayAlerts = 0
try { $d = $w.Documents.Open(${q(src)}, $false, $true)
  $d.Content.Copy()
  $o = New-Object -ComObject Outlook.Application
  $m = $o.CreateItem(0); $m.Subject = [IO.Path]::GetFileNameWithoutExtension(${q(src)}); $m.Display()
  $m.GetInspector.WordEditor.Range(0,0).Paste()
} finally { if ($d) { $d.Close($false) }; $w.Quit() }`);
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

module.exports = { runJobs, toPdf, docToPdf, docToMail, composeMail, appFor, ps, q, isWin };
