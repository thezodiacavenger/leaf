// Turns whatever was dropped (zips, folders, loose files) into one flat list of "items"
// that can be read lazily. Nothing is extracted to disk at this stage.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const yauzl = require('yauzl');
const { RAW } = require('./raw');

const HEIC = new Set(['.heic', '.heif', '.hif']);
const RASTER = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.ico']);
const NATIVE_DECODE = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.ico']); // what nativeImage reads everywhere
const TIFF = new Set(['.tif', '.tiff']);
const DOC = new Set(['.docx', '.doc', '.rtf', '.odt', '.docm']);
const ARCHIVE = new Set(['.zip']);
const JUNK = /(^|\/)(__MACOSX\/|\._|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;
const MAX_WALK = 10000;

function kindOf(ext) {
  if (HEIC.has(ext)) return 'heic';
  if (RAW.has(ext)) return 'raw';
  if (TIFF.has(ext)) return 'tiff';
  if (RASTER.has(ext)) return 'raster';
  if (DOC.has(ext)) return 'doc';
  if (ext === '.pdf') return 'pdf';
  if (ARCHIVE.has(ext)) return 'archive';
  return 'other';
}

function safeRel(name) {
  const norm = path.posix.normalize(name.replace(/\\/g, '/')).replace(/^\/+/, '');
  if (!norm || norm.startsWith('..') || path.isAbsolute(norm) || /^[a-z]:/i.test(norm)) return null;
  return norm;
}

function openZip(file) {
  return new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => (err ? reject(err) : resolve(zip))));
}

async function listZip(file) {
  const zip = await openZip(file);
  const entries = await new Promise((resolve, reject) => {
    const out = [];
    zip.on('entry', (e) => { out.push(e); zip.readEntry(); });
    zip.on('end', () => resolve(out));
    zip.on('error', reject);
    zip.readEntry();
  });
  const readEntry = (entry) => new Promise((resolve, reject) => {
    if (entry.generalPurposeBitFlag & 0x1) return reject(new Error('password-protected'));
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = []; stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks))); stream.on('error', reject);
    });
  });
  const items = [];
  for (const e of entries) {
    if (e.fileName.endsWith('/') || JUNK.test(e.fileName)) continue;
    const rel = safeRel(e.fileName); if (!rel) continue;
    const ext = path.extname(rel).toLowerCase();
    items.push({ rel, name: path.basename(rel), ext, kind: kindOf(ext), size: e.uncompressedSize, read: () => readEntry(e) });
  }
  // "Trip.zip" containing only "Trip/..." -> don't nest Trip twice in the output.
  const top = items.length && items[0].rel.includes('/') ? items[0].rel.split('/')[0] + '/' : null;
  if (top && items.every((it) => it.rel.startsWith(top))) items.forEach((it) => { it.rel = it.rel.slice(top.length); });
  return { items, close: () => zip.close() };
}

async function walkDir(root) {
  const items = []; const stack = [''];
  while (stack.length && items.length < MAX_WALK) {
    const relDir = stack.pop();
    for (const d of await fsp.readdir(path.join(root, relDir), { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      if (JUNK.test(rel)) continue;
      if (d.isDirectory()) { stack.push(rel); continue; }
      if (!d.isFile()) continue;
      const abs = path.join(root, rel); const ext = path.extname(d.name).toLowerCase();
      items.push({ rel, name: d.name, ext, kind: kindOf(ext), abs, size: fs.statSync(abs).size, read: () => fsp.readFile(abs) });
    }
  }
  return items;
}

// Builds a "drop" = one or more sources, each with items and an output rule.
async function inspect(paths) {
  const sources = [];
  for (const p of paths) {
    const st = await fsp.stat(p);
    const ext = path.extname(p).toLowerCase();
    if (st.isDirectory()) {
      sources.push({ type: 'folder', path: p, label: path.basename(p), items: await walkDir(p) });
    } else if (ARCHIVE.has(ext)) {
      const z = await listZip(p);
      sources.push({ type: 'zip', path: p, label: path.basename(p), size: st.size, items: z.items, close: z.close });
    } else {
      sources.push({ type: 'file', path: p, label: path.basename(p), size: st.size,
        items: [{ rel: path.basename(p), name: path.basename(p), ext, kind: kindOf(ext), abs: p, size: st.size, read: () => fsp.readFile(p) }] });
    }
  }
  return sources;
}

module.exports = { inspect, kindOf, NATIVE_DECODE, HEIC, RASTER, DOC, TIFF, isPhoto: (it) => ['heic', 'raw', 'tiff'].includes(it.kind) || (it.kind === 'raster' && NATIVE_DECODE.has(it.ext)) };
