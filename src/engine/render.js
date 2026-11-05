// HTML -> PDF in a locked-down hidden window: no JavaScript, no network (tracking pixels and remote
// content never load), only the one temp file Leaf wrote may be read.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, session } = require('electron');

const DIR = path.join(os.tmpdir(), 'leaf-render');
const allowedUrls = new Set();
let ses; let seq = 0;

function lockedSession() {
  if (ses) return ses;
  ses = session.fromPartition('leaf-render');
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(d.url.startsWith('data:') || allowedUrls.has(d.url)) }));
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  return ses;
}

// One reusable hidden window; jobs run one at a time.
let win = null; let chain = Promise.resolve(); let idle = null;
function renderWindow() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({ show: false, width: 816, height: 1056, webPreferences: { session: lockedSession(), javascript: false, sandbox: true, contextIsolation: true, spellcheck: false, backgroundThrottling: false } });
  return win;
}

function htmlToPdf(html, opts = {}) {
  const job = chain.then(() => render(html, opts));
  chain = job.catch(() => {});
  return job;
}

async function render(html, { footer = '' }) {
  clearTimeout(idle);
  await fsp.mkdir(DIR, { recursive: true });
  const file = path.join(DIR, `${Date.now().toString(36)}-${++seq}.html`);
  await fsp.writeFile(file, html, 'utf8');
  const url = pathToFileURL(file).toString(); allowedUrls.add(url);
  const w = renderWindow();
  try {
    await w.loadURL(url);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return Buffer.from(await w.webContents.printToPDF({
      pageSize: 'Letter', printBackground: true, preferCSSPageSize: true,
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: `<div style="font:8px 'Segoe UI',Arial,sans-serif;color:#888;width:100%;padding:0 0.6in;display:flex;justify-content:space-between"><span>${esc(footer)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    }));
  } finally {
    allowedUrls.delete(url); fs.rm(file, { force: true }, () => {});
    idle = setTimeout(() => { if (win && !win.isDestroyed()) win.destroy(); win = null; }, 30000);
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Plain text files (and anything we can only show as text) as a tidy PDF.
const textToPdf = (text, title) => htmlToPdf(`<!doctype html><meta charset="utf-8"><style>@page{size:Letter;margin:.7in} body{margin:0} pre{white-space:pre-wrap;font:9.5pt/1.45 Consolas,"Cascadia Mono",monospace}</style><pre>${esc(text)}</pre>`, { footer: title });

module.exports = { htmlToPdf, textToPdf, close: () => { if (win && !win.isDestroyed()) win.destroy(); } };
