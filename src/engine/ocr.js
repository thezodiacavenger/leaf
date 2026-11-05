// "Make searchable PDF": Windows' built-in OCR (Windows.Media.Ocr — offline, free, Windows 10 & 11)
// reads each page; Leaf lays invisible, selectable text over the original image so search/copy work.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');
const { StandardFonts } = require('@cantoo/pdf-lib');
const office = require('./office');
const pdf = require('./pdf');
const { safe } = require('./report');

// ---------- hidden pdf.js renderer (only for scanned PDFs) ----------
let win = null; let ready = null; let seq = 0; const pending = new Map(); let idle = null;
ipcMain.on('workroom:done', (_e, { id, ...r }) => { const j = pending.get(id); if (j) { pending.delete(id); r.error ? j.reject(new Error(r.error)) : j.resolve(r); } });
function workroom() {
  if (win && !win.isDestroyed()) return ready;
  win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '..', 'workroom-preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  ready = new Promise((res) => { const on = (e) => { if (win && e.sender === win.webContents) { ipcMain.removeListener('workroom:ready', on); res(); } }; ipcMain.on('workroom:ready', on); });
  win.on('closed', () => { win = null; ready = null; for (const [id, j] of pending) { j.reject(new Error('closed')); pending.delete(id); } });
  win.loadURL('leaf://app/src/ui/workroom.html');
  return ready;
}
async function renderPages(bytes) {
  clearTimeout(idle); await workroom();
  const r = await new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); win.webContents.send('workroom:job', { id, method: 'renderPages', bytes: new Uint8Array(bytes) }); });
  idle = setTimeout(() => { if (win && !win.isDestroyed()) win.destroy(); }, 30000);
  return r.pages;
}

// ---------- Windows OCR via PowerShell + WinRT ----------
const OCR_PS = (inFile, outFile) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { throw 'NO_OCR_LANGUAGE' }
$paths = Get-Content -Raw -Encoding UTF8 ${office.q(inFile)} | ConvertFrom-Json
$out = New-Object System.Collections.ArrayList
foreach ($p in $paths) {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $bmp = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert($bmp, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8)
    $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    $words = New-Object System.Collections.ArrayList
    foreach ($l in $res.Lines) { foreach ($w in $l.Words) { $r = $w.BoundingRect; [void]$words.Add(@{ t = $w.Text; x = $r.X; y = $r.Y; w = $r.Width; h = $r.Height }) } }
    [void]$out.Add(@{ w = $bmp.PixelWidth; h = $bmp.PixelHeight; words = @($words) })
  } finally { $stream.Dispose() }
}
[IO.File]::WriteAllText(${office.q(outFile)}, (ConvertTo-Json -InputObject @{ pages = @($out); lang = $engine.RecognizerLanguage.LanguageTag } -Depth 6 -Compress), [Text.Encoding]::UTF8)
`;

// Windows OCR caps image size at 10,000 px; keep it comfortably below.
async function ocrImages(files) {
  if (!office.isWin) throw new Error('Needs Windows 10 or 11 (uses the built-in text recognition)');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'leaf-ocr-'));
  try {
    const inF = path.join(dir, 'in.json'); const outF = path.join(dir, 'out.json');
    await fsp.writeFile(inF, JSON.stringify(files), 'utf8');
    try { await office.ps(OCR_PS(inF, outF), Math.max(120000, files.length * 30000)); }
    catch (e) { throw new Error(/NO_OCR_LANGUAGE/.test(e.message) ? 'No text-recognition language is installed (Settings › Time & language › Language › add “Optical character recognition”)' : `Text recognition failed: ${e.message}`); }
    return JSON.parse((await fsp.readFile(outF, 'utf8')).replace(/^﻿/, ''));
  } finally { fs.rm(dir, { recursive: true, force: true }, () => {}); }
}

// Invisible, selectable words placed over the picture. toPt maps OCR pixels -> page points.
function overlay(page, font, words, toPt) {
  let n = 0;
  for (const w of words) {
    const text = safe(font, w.t).trim(); if (!text) continue;
    const a = toPt(w.x, w.y + w.h); const b = toPt(w.x + w.w, w.y);
    const width = Math.abs(b.x - a.x); const height = Math.abs(b.y - a.y);
    const unit = font.widthOfTextAtSize(text, 1); if (!unit || !height) continue;
    const size = Math.max(1, Math.min(width / unit, height * 1.3));
    page.drawText(text, { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) + height * 0.15, size, font, opacity: 0 });
    n++;
  }
  return n;
}

async function writeTmp(name, bytes) { const p = path.join(os.tmpdir(), 'leaf-src', `${Date.now().toString(36)}-${name}`); await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, bytes); return p; }

async function searchable(list, ctx, h, emit, beside) {
  const { PDFDocument } = require('@cantoo/pdf-lib');
  await h.each(list, 1, ctx, async ({ it, src }) => {
    const tmps = [];
    try {
      if (it.kind === 'pdf') {
        const bytes = await it.read(); const doc = await pdf.open(bytes); const font = await doc.embedFont(StandardFonts.Helvetica);
        const pages = (await renderPages(bytes)).filter((p) => p.png);
        if (!pages.length) throw new Error('Already searchable — every page has text');
        for (const p of pages) tmps.push(await writeTmp(`p${p.n}.png`, Buffer.from(p.png)));
        const res = await module.exports.ocrImages(tmps); let words = 0;
        pages.forEach((p, i) => {
          const page = doc.getPage(p.n - 1); const [x0, , , y1] = p.view;
          words += overlay(page, font, res.pages[i].words, (x, y) => ({ x: x0 + x / p.scale, y: y1 - y / p.scale }));
        });
        await emit(ctx, h, beside(it, src, ' (searchable)', '.pdf'), Buffer.from(await doc.save({ useObjectStreams: true })), { note: `${pages.length} page${pages.length === 1 ? '' : 's'} read · ${words} words · ${res.lang}` });
      } else {
        // Photos / scans / multi-page fax TIFFs
        const { img } = await h.toImage(it);
        const pages = it.kind === 'tiff' && it.pages > 1 ? require('./report').tiffPages(await it.read()) : [{ img }];
        for (let i = 0; i < pages.length; i++) tmps.push(await writeTmp(`i${i}.png`, h.fit(pages[i].img, 6000).toPNG()));
        const res = await module.exports.ocrImages(tmps);
        const doc = await PDFDocument.create({ updateMetadata: false }); const font = await doc.embedFont(StandardFonts.Helvetica); let words = 0;
        for (let i = 0; i < pages.length; i++) {
          const pg = pages[i]; const im = h.fit(pg.img, 6000); const { width, height } = im.getSize();
          const wPt = pg.wPt || 612; const hPt = pg.hPt || (612 * height) / width;
          const emb = pg.bilevel ? await doc.embedPng(im.toPNG()) : await doc.embedJpg(im.toJPEG(85));
          const page = doc.addPage([wPt, hPt]); page.drawImage(emb, { x: 0, y: 0, width: wPt, height: hPt });
          const r = res.pages[i]; const sx = wPt / r.w; const sy = hPt / r.h;
          words += overlay(page, font, r.words, (x, y) => ({ x: x * sx, y: hPt - y * sy }));
        }
        await emit(ctx, h, beside(it, src, ' (searchable)', '.pdf'), Buffer.from(await doc.save({ useObjectStreams: true })), { note: `${words} words recognised · ${res.lang}` });
      }
    } finally { tmps.forEach((t) => fs.rm(t, { force: true }, () => {})); }
  });
}

module.exports = { searchable, renderPages, ocrImages, overlay };
