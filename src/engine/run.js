// Executes a chosen action against a drop. Streams progress, never touches originals.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { nativeImage } = require('electron');
const { PDFDocument } = require('pdf-lib');
const { DecodePool } = require('./pool');
const { NATIVE_DECODE } = require('./sources');
const office = require('./office');

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

async function toImage(item) {
  const buf = await item.read();
  if (item.kind === 'heic') {
    const { width, height, data } = await getPool().decode(buf);
    return nativeImage.createFromBitmap(Buffer.from(data), { width, height });
  }
  if (NATIVE_DECODE.has(item.ext)) {
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) throw new Error('unreadable image');
    return img;
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

  if (action.id === 'convert' || action.id === 'shrink') {
    const target = action.id === 'shrink' ? 'jpeg' : action.target;
    const ext = target === 'png' ? '.png' : '.jpg';
    const tag = action.id === 'shrink' ? 'email size' : target.toUpperCase();
    for (const src of sources) {
      const outRoot = outDirFor(src, tag); ctx.dirs.add(outRoot);
      const work = src.items.filter((it) => it.kind === 'heic' || (it.kind === 'raster' && NATIVE_DECODE.has(it.ext)));
      // Zips: extract the non-image files too, so the result is a complete, usable folder.
      if (src.type === 'zip') {
        for (const it of src.items.filter((x) => !work.includes(x))) {
          const dest = path.join(outRoot, it.rel); await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.writeFile(dest, await it.read());
        }
      }
      await each(work, lanes, ctx, async (it, n) => {
        let img = await toImage(it);
        if (action.id === 'shrink') img = fit(img, 2048);
        const relOut = it.rel.slice(0, it.rel.length - it.ext.length) + (action.id === 'shrink' && src.type === 'file' ? ' (email)' : '') + ext;
        const dest = uniquePath(path.join(outRoot, src.type === 'file' ? path.basename(relOut) : relOut));
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        const bytes = target === 'png' ? img.toPNG() : img.toJPEG(action.id === 'shrink' ? 82 : quality);
        await fsp.writeFile(dest, bytes);
        const { width, height } = img.getSize();
        ctx.outputs.push({ path: dest, name: path.basename(dest), width, height, bytes: bytes.length, order: it.rel, thumb: await writeThumb(img, jobId, ++thumbSeq) });
      });
    }
  } else if (action.id === 'pdf') {
    const pdf = await PDFDocument.create();
    const items = sources.flatMap((s) => s.items).filter((it) => it.kind === 'heic' || (it.kind === 'raster' && NATIVE_DECODE.has(it.ext)))
      .sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
    const pages = new Array(items.length);
    await each(items, lanes, ctx, async (it, n) => { pages[n] = fit(await toImage(it), 2400).toJPEG(85); });
    for (const jpg of pages.filter(Boolean)) {
      const im = await pdf.embedJpg(jpg); const s = Math.min(1, 842 / Math.max(im.width, im.height));
      pdf.addPage([im.width * s, im.height * s]).drawImage(im, { x: 0, y: 0, width: im.width * s, height: im.height * s });
    }
    const first = sources[0];
    const base = first.type === 'file' ? path.parse(first.path).name : path.basename(first.path, path.extname(first.path));
    const dest = uniquePath(path.join(path.dirname(first.path), `${base}.pdf`));
    const bytes = await pdf.save(); await fsp.writeFile(dest, bytes);
    ctx.outputs.push({ path: dest, name: path.basename(dest), bytes: bytes.length, kind: 'pdf' });
  } else if (action.id === 'unzip') {
    for (const src of sources.filter((s) => s.type === 'zip')) {
      const outRoot = outDirFor(src, 'unzipped'); ctx.dirs.add(outRoot);
      await each(src.items, 4, ctx, async (it) => {
        const dest = path.join(outRoot, it.rel); await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, await it.read()); ctx.outputs.push({ path: dest, name: it.name, bytes: it.size, kind: 'file' });
      });
    }
  } else if (action.id === 'doc-pdf' || action.id === 'doc-attach') {
    const docs = sources.flatMap((s) => s.items).filter((it) => it.kind === 'doc' && it.abs);
    await each(docs, 1, ctx, async (it) => {
      const dest = uniquePath(path.join(path.dirname(it.abs), `${path.parse(it.abs).name}.pdf`));
      await office.docToPdf(it.abs, dest);
      ctx.outputs.push({ path: dest, name: path.basename(dest), bytes: fs.statSync(dest).size, kind: 'pdf' });
    });
    if (action.id === 'doc-attach' && ctx.outputs.length) await office.composeMail({ attachments: ctx.outputs.map((o) => o.path), subject: path.parse(docs[0].name).name });
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
