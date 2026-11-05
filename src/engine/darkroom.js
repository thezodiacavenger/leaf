// Main-process side of the darkroom: a hidden window running LibRaw (see ui/darkroom.html).
// Two RAWs develop at once at most (each can use ~1 GB); the window closes after a minute idle to give memory back.
const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');

const MAX_PARALLEL = 2; const IDLE_MS = 60000;
let win = null; let ready = null; let seq = 0; let active = 0; let idleTimer = null;
const pending = new Map(); const queue = [];

ipcMain.on('darkroom:done', (_e, { id, error, width, height, data }) => {
  const job = pending.get(id); if (!job) return;
  pending.delete(id); active--;
  error ? job.reject(new Error(error)) : job.resolve({ width, height, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength) });
  pump();
});

function open() {
  if (win && !win.isDestroyed()) return ready;
  win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '..', 'darkroom-preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  ready = new Promise((resolve, reject) => {
    const onReady = (e) => { if (win && e.sender === win.webContents) { ipcMain.removeListener('darkroom:ready', onReady); resolve(); } };
    ipcMain.on('darkroom:ready', onReady);
    win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`darkroom failed to load: ${desc}`)));
  });
  win.on('closed', () => {
    win = null; ready = null;
    for (const [id, job] of pending) { job.reject(new Error('darkroom closed')); pending.delete(id); }
    active = 0;
  });
  // Served over leaf://app so it is cross-origin isolated (LibRaw's threads need SharedArrayBuffer).
  win.loadURL('leaf://app/src/ui/darkroom.html');
  return ready;
}

async function pump() {
  clearTimeout(idleTimer);
  while (active < MAX_PARALLEL && queue.length) {
    const job = queue.shift(); active++;
    try { await open(); } catch (e) { active--; job.reject(e); continue; }
    pending.set(job.id, job);
    win.webContents.send('darkroom:job', { id: job.id, bytes: job.bytes, ext: job.ext, preview: job.preview });
  }
  if (!active && !queue.length) idleTimer = setTimeout(() => { if (win && !win.isDestroyed()) win.destroy(); }, IDLE_MS);
}

function develop(bytes, ext, preview) {
  return new Promise((resolve, reject) => {
    queue.push({ id: ++seq, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), ext, preview: preview ? new Uint8Array(preview) : null, resolve, reject });
    pump();
  });
}

module.exports = { develop, close: () => { if (win && !win.isDestroyed()) win.destroy(); } };
