// Executes a chosen action against a drop. Streams progress, never touches originals.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { nativeImage } = require('electron');
const { PDFDocument } = require('@cantoo/pdf-lib');
const { DecodePool } = require('./pool');
const { NATIVE_DECODE, isPhoto } = require('./sources');
const office = require('./office');
const raw = require('./raw');
const darkroom = require('./darkroom');
const docs = require('./docs');

let pool; let thumbSeq = 0;
const getPool = () => (pool ||= new DecodePool());
const THUMB_DIR = path.join(os.tmpdir(), 'leaf-thumbs');

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 2; ; i++) { const q = path.join(dir, `${name} (${i})${ext}`); if (!fs.existsSync(q)) return q; }
}

// Where results go: archives/folders -> a new sibling folder; loose files -> next to themselves.
function outDirFor(source, tag) {
  if (source.type === 'file') return path.dirname(source.path);
  const base = source.type === 'zip' ? path.basename(source.path, path.extname(source.path)) : path.basename(source.path);
  return uniquePath(path.join(path.dirname(source.path), `${base} (${tag})`));
}

// Decodes any supported photo. Returns the image plus a file to copy metadata from.
async function toImage(item) {
  const buf = await item.read();
  if (item.kind === 'heic') {
    const { width, height, data } = await getPool().decode(buf);
    return { img: nativeImage.createFromBitmap(Buffer.from(data), { width, height }), metaSrc: await raw.onDisk(item, buf) };
  }
  if (item.kind === 'raw') {
    const metaSrc = await raw.onDisk(item, buf);
    const info = await raw.rawInfo(metaSrc);
    const emb = raw.largestJpeg(buf);
    const full = Math.max(info.width, info.height);
    // The camera's own JPEG when it's (nearly) full size: instant, camera colours. Otherwise develop the RAW.
    if (emb && (!full || Math.max(emb.width, emb.height) >= 0.9 * full)) {
      let img = nativeImage.createFromBuffer(Buffer.from(emb.data));
      if (!img.isEmpty()) {
        if ([3, 6, 8].includes(info.orientation)) {
          const { width, height } = img.getSize();
          const r = raw.rotate(img.toBitmap(), width, height, info.orientation);
          img = nativeImage.createFromBitmap(r.data, { width: r.width, height: r.height });
        }
        return { img, metaSrc, how: 'camera' };
      }
    }
    const d = await darkroom.develop(buf, item.ext, emb && emb.data); // camera JPEG = colour/tone reference
    return { img: nativeImage.createFromBitmap(d.data, { width: d.width, height: d.height }), metaSrc, how: 'developed' };
  }
  if (item.kind === 'tiff') {
    const UTIF = require('utif');
    const ifds = UTIF.decode(buf);
    const page = ifds.filter((f) => f.t256 && f.t257).sort((a, b) => b.t256[0] * b.t257[0] - a.t256[0] * a.t257[0])[0];
    if (!page) throw new Error('no image in this TIFF');
    UTIF.decodeImage(buf, page);
    const rgba = UTIF.toRGBA8(page); const { width, height } = page;
    for (let i = 0; i < rgba.length; i += 4) { const r = rgba[i]; rgba[i] = rgba[i + 2]; rgba[i + 2] = r; }
    return { img: nativeImage.createFromBitmap(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { width, height }), metaSrc: await raw.onDisk(item, buf) };
  }
  if (NATIVE_DECODE.has(item.ext)) {
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) throw new Error('unreadable image');
    return { img, metaSrc: item.abs };
  }
  throw new Error(`can't read ${item.ext} yet`);
}

function fit(img, longEdge) {
  const { width, height } = img.getSize();
  if (Math.max(width, height) <= longEdge) return img;
  return width >= height ? img.resize({ width: longEdge, quality: 'best' }) : img.resize({ height: longEdge, quality: 'best' });
}

async function writeThumb(img, jobId, n) {
  const dir = path.join(THUMB_DIR, jobId); await fsp.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${n}.jpg`); await fsp.writeFile(p, fit(img, 520).toJPEG(80)); return p;
}

// Runs fn over items with bounded concurrency, reporting progress.
async function each(items, limit, ctx, fn) {
  let i = 0; let done = 0;
  const lane = async () => {
    while (i < items.length) {
      if (ctx.cancelled) return;
      const idx = i++; const it = items[idx];
      try { await fn(it, idx); } catch (e) { ctx.failures.push({ name: it.name, reason: e.message }); }
      ctx.progress(++done, items.length, it.name);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

async function run(sources, action, ctx) {
  ctx.failures = []; ctx.outputs = []; ctx.dirs = new Set();
  const lanes = getPool().size + 1;
  const jobId = `${Date.now().toString(36)}`;
  const quality = ctx.settings?.jpegQuality ?? 90;

  if (docs.handles(action.id)) {
    await docs.run(sources, action, ctx, { each, toImage, fit, uniquePath });
  } else if (action.id === 'convert' || action.id === 'shrink') {
    const target = action.id === 'shrink' ? 'jpeg' : action.target;
    const ext = target === 'png' ? '.png' : '.jpg';
    const tag = action.id === 'shrink' ? 'email size' : target.toUpperCase();
    for (const src of sources) {
      const outRoot = outDirFor(src, tag); ctx.dirs.add(outRoot);
      const work = src.items.filter(isPhoto);
      // Zips: extract the non-image files too, so the result is a complete, usable folder.
      if (src.type === 'zip') {
        for (const it of src.items.filter((x) => !work.includes(x))) {
          const dest = path.join(outRoot, it.rel); await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.writeFile(dest, await it.read());
        }
      }
      await each(work, lanes, ctx, async (it, n) => {
        const decoded = await toImage(it); let { img } = decoded;
        if (action.id === 'shrink') img = fit(img, 2048);
        const relOut = it.rel.slice(0, it.rel.length - it.ext.length) + (action.id === 'shrink' && src.type === 'file' ? ' (email)' : '') + ext;
        const dest = uniquePath(path.join(outRoot, src.type === 'file' ? path.basename(relOut) : relOut));
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        const bytes = target === 'png' ? img.toPNG() : img.toJPEG(action.id === 'shrink' ? 82 : quality);
        await fsp.writeFile(dest, bytes);
        if (decoded.metaSrc && decoded.metaSrc !== dest) await raw.copyMeta(decoded.metaSrc, dest, { stripGps: action.id === 'shrink' });
        const { width, height } = img.getSize();
        ctx.outputs.push({ path: dest, name: path.basename(dest), width, height, bytes: fs.statSync(dest).size, order: it.rel, source: it.abs || decoded.metaSrc, how: decoded.how, thumb: await writeThumb(img, jobId, ++thumbSeq) });
      });
    }
  } else if (action.id === 'pdf') {
    const pdf = await PDFDocument.create();
    const items = sources.flatMap((s) => s.items).filter(isPhoto)
      .sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
    const pages = new Array(items.length);
    await each(items, lanes, ctx, async (it, n) => { pages[n] = fit((await toImage(it)).img, 2400).toJPEG(85); });
    for (const jpg of pages.filter(Boolean)) {
      const im = await pdf.embedJpg(jpg); const s = Math.min(1, 842 / Math.max(im.width, im.height));
      pdf.addPage([im.width * s, im.height * s]).drawImage(im, { x: 0, y: 0, width: im.width * s, height: im.height * s });
    }
    const first = sources[0];
    const base = first.type === 'file' ? path.parse(first.path).name : path.basename(first.path, path.extname(first.path));
    const dest = uniquePath(path.join(path.dirname(first.path), `${base}.pdf`));
    const bytes = await pdf.save(); await fsp.writeFile(dest, bytes);
    ctx.outputs.push({ path: dest, name: path.basename(dest), bytes: bytes.length, kind: 'pdf' });
  } else if (action.id === 'zip') {
    const yazl = require('yazl');
    const STORED = /\.(jpe?g|png|gif|webp|heic|heif|avif|mp4|mov|m4v|mp3|m4a|zip|7z|rar|gz|docx|xlsx|pptx|pdf|cr2|cr3|nef|nrw|arw|raf|orf|rw2|dng|pef|srw|rwl|3fr|iiq|x3f)$/i;
    const entries = []; const used = new Set();
    for (const src of sources) {
      if (src.type === 'zip') entries.push({ abs: src.path, rel: path.basename(src.path), size: src.size });
      else if (src.type === 'folder') src.items.forEach((it) => entries.push({ abs: it.abs, rel: `${path.basename(src.path)}/${it.rel}`, size: it.size }));
      else entries.push({ abs: src.path, rel: path.basename(src.path), size: src.size });
    }
    for (const e of entries) { let r = e.rel; const p = path.posix.parse(r); for (let i = 2; used.has(r.toLowerCase()); i++) r = `${p.dir ? p.dir + '/' : ''}${p.name} (${i})${p.ext}`; used.add(r.toLowerCase()); e.rel = r; }
    const first = sources[0];
    const home = first.type === 'folder' && sources.length === 1 ? path.dirname(first.path) : path.dirname(first.path);
    const base = first.type === 'folder' && sources.length === 1 ? path.basename(first.path) : (path.basename(home) || 'Files');
    const dest = uniquePath(path.join(home, `${base}.zip`));
    const z = new yazl.ZipFile(); const out = fs.createWriteStream(dest);
    const total = entries.reduce((a, e) => a + (e.size || 0), 0) || 1;
    const marks = []; let acc = 0; for (const e of entries) { acc += e.size || 0; marks.push(acc); }
    let written = 0; let shown = 0;
    z.outputStream.on('data', (c) => { written += c.length; while (shown < entries.length && written >= marks[shown] * 0.98) { shown++; ctx.progress(shown, entries.length, entries[shown - 1].rel); } });
    const finished = new Promise((res, rej) => { out.on('close', res); out.on('error', rej); z.outputStream.on('error', rej); });
    z.outputStream.pipe(out);
    for (const e of entries) z.addFile(e.abs, e.rel, { compress: !STORED.test(e.rel) });
    z.end(); await finished; ctx.progress(entries.length, entries.length, '');
    if (ctx.cancelled) { fs.rmSync(dest, { force: true }); } else ctx.outputs.push({ path: dest, name: path.basename(dest), bytes: fs.statSync(dest).size, kind: 'zip', note: `${entries.length} files · ${Math.round(total / 1e6)} MB before zipping` });
  } else if (action.id === 'unzip') {
    for (const src of sources.filter((s) => s.type === 'zip')) {
      const outRoot = outDirFor(src, 'unzipped'); ctx.dirs.add(outRoot);
      await each(src.items, 4, ctx, async (it) => {
        const dest = path.join(outRoot, it.rel); await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, await it.read()); ctx.outputs.push({ path: dest, name: it.name, bytes: it.size, kind: 'file' });
      });
    }
  } else if (action.id === 'doc-mail') {
    const doc = sources.flatMap((s) => s.items).find((it) => it.kind === 'doc' && it.abs);
    ctx.progress(0, 1, doc.name);
    await office.docToMail(doc.abs);
    ctx.progress(1, 1, doc.name);
  }

  sources.forEach((s) => s.close && s.close());
  ctx.outputs.sort((a, b) => String(a.order || a.name).localeCompare(String(b.order || b.name), undefined, { numeric: true }));
  return { outputs: ctx.outputs, failures: ctx.failures, dirs: [...ctx.dirs], cancelled: !!ctx.cancelled, action: action.id };
}

// Makes email-sized copies in a temp folder (used when the user emails big photos).
async function emailCopies(files) {
  const dir = path.join(os.tmpdir(), 'leaf-email', Date.now().toString(36)); await fsp.mkdir(dir, { recursive: true });
  const out = [];
  for (const f of files) {
    const img = nativeImage.createFromPath(f); if (img.isEmpty()) { out.push(f); continue; }
    const dest = path.join(dir, path.parse(f).name + '.jpg'); await fsp.writeFile(dest, fit(img, 2048).toJPEG(80)); out.push(dest);
  }
  return out;
}

module.exports = { run, emailCopies, shutdown: () => pool && pool.destroy() };
