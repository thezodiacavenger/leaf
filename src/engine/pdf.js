// PDF toolkit: combine (with bookmarks), flatten forms, compress for email, split/extract/rotate,
// password protect/unlock, remove hidden data, images -> PDF pages.
const zlib = require('node:zlib');
const { nativeImage } = require('electron');
const { PDFDocument, PDFName, PDFRawStream, PDFHexString, PDFArray, PDFNull, PDFNumber, PDFDict, degrees } = require('@cantoo/pdf-lib');

const LETTER = [612, 792];

// Once decrypted in memory, drop the encryption marker so saved copies are plain, valid PDFs
// (otherwise strict readers like Acrobat try to decrypt content that is already decrypted).
function plain(doc) {
  const enc = doc.context.trailerInfo.Encrypt;
  if (enc) { try { if (enc.objectNumber != null) doc.context.delete(enc); } catch {} doc.context.trailerInfo.Encrypt = undefined; }
  try { doc.isEncrypted = false; } catch {}
  // The source file's old cross-reference streams (and the encryption dictionary they point to) get carried
  // over as stray objects; some readers mistake them for the live trailer. Drop them — save() writes fresh ones.
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    const type = obj && obj.dict && obj.dict.get(PDFName.of('Type'));
    const isEncDict = obj instanceof PDFDict && obj.get(PDFName.of('Filter')) && obj.get(PDFName.of('O')) && obj.get(PDFName.of('U'));
    const isOldTrailer = obj instanceof PDFDict && obj.get(PDFName.of('Root')) && obj.get(PDFName.of('Size'));
    if ((type && type.asString && type.asString() === '/XRef') || isEncDict || isOldTrailer) doc.context.delete(ref);
  }
  return doc;
}

// Opens any PDF. Owner-restricted PDFs (no open password) are decrypted transparently.
async function open(bytes, password) {
  try { return plain(await PDFDocument.load(bytes, { updateMetadata: false, ...(password != null ? { password } : {}) })); }
  catch (e) {
    if (password == null && /encrypt/i.test(e.message)) {
      try { return plain(await PDFDocument.load(bytes, { updateMetadata: false, password: '' })); }
      catch { const err = new Error('This PDF needs a password. Use “Remove password”.'); err.needsPassword = true; throw err; }
    }
    if (/password/i.test(e.message)) throw new Error('That password didn’t open this PDF.');
    throw e;
  }
}

// Quick facts used to choose suggestions (pages, form, scanned, locked).
async function facts(bytes) {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
    const encrypted = !!doc.isEncrypted;
    let needsPassword = false;
    if (encrypted) { try { await PDFDocument.load(bytes, { updateMetadata: false, password: '' }); } catch { needsPassword = true; } }
    let hasForm = false; try { hasForm = !encrypted && doc.getForm().getFields().length > 0; } catch {}
    // "Scanned": no page uses a font but pages carry images.
    let fonts = 0; let images = 0;
    if (!encrypted) for (const page of doc.getPages().slice(0, 20)) {
      const res = page.node.Resources(); if (!res) continue;
      const f = res.lookup(PDFName.of('Font')); if (f instanceof PDFDict && f.keys().length) fonts++;
      const x = res.lookup(PDFName.of('XObject')); if (x instanceof PDFDict && x.keys().length) images++;
    }
    return { pages: doc.getPageCount(), encrypted, needsPassword, hasForm, scanned: !encrypted && fonts === 0 && images > 0 };
  } catch { return { pages: 0, broken: true }; }
}

function flattenForm(doc) {
  try {
    const form = doc.getForm();
    try { form.deleteXFA(); } catch {}
    if (!form.getFields().length) return false;
    try { form.flatten({ updateFieldAppearances: true }); } catch { form.flatten({ updateFieldAppearances: false }); }
    return true;
  } catch { return false; }
}

// Side-panel bookmarks: one per combined document.
function addOutline(doc, entries) {
  if (!entries.length) return;
  const ctx = doc.context; const outlinesRef = ctx.nextRef(); const refs = entries.map(() => ctx.nextRef());
  const pages = doc.getPages();
  entries.forEach((e, i) => {
    const d = { Title: PDFHexString.fromText(e.title.slice(0, 200)), Parent: outlinesRef, Dest: ctx.obj([pages[e.page].ref, PDFName.of('XYZ'), PDFNull, PDFNull, PDFNull]) };
    if (i > 0) d.Prev = refs[i - 1]; if (i < refs.length - 1) d.Next = refs[i + 1];
    ctx.assign(refs[i], ctx.obj(d));
  });
  ctx.assign(outlinesRef, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: PDFNumber.of(refs.length) }));
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

// parts: [{ bytes, title }] -> one PDF, forms flattened, a bookmark per part.
async function combine(parts, { flatten = true } = {}) {
  const out = await PDFDocument.create({ updateMetadata: false }); const marks = [];
  for (const p of parts) {
    const src = await open(p.bytes);
    if (flatten) flattenForm(src);
    const start = out.getPageCount();
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((pg) => out.addPage(pg));
    if (pages.length) marks.push({ title: p.title, page: start });
  }
  addOutline(out, marks);
  return Buffer.from(await out.save({ useObjectStreams: true }));
}

async function flatten(bytes) {
  const doc = await open(bytes);
  if (!flattenForm(doc)) throw new Error('This PDF has no fillable fields');
  return Buffer.from(await doc.save({ useObjectStreams: true }));
}

async function rotate(bytes, by = 90) {
  const doc = await open(bytes);
  for (const p of doc.getPages()) p.setRotation(degrees((p.getRotation().angle + by) % 360));
  return Buffer.from(await doc.save({ useObjectStreams: true }));
}

// "1-3, 7, 10-" -> zero-based page indexes
function parseRanges(text, count) {
  const out = [];
  for (const part of String(text).split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*[-–]\s*(\d*)$/) || part.match(/^(\d+)$/);
    if (!m) throw new Error(`“${part}” isn’t a page or range`);
    const a = m[2] === undefined ? +m[1] : m[1] ? +m[1] : 1; const b = m[2] === undefined ? +m[1] : m[2] ? +m[2] : count;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= count && !out.includes(i - 1)) out.push(i - 1);
  }
  if (!out.length) throw new Error(`Pick pages between 1 and ${count}`);
  return out;
}

async function extract(bytes, ranges) {
  const src = await open(bytes); const idx = parseRanges(ranges, src.getPageCount());
  const out = await PDFDocument.create({ updateMetadata: false });
  (await out.copyPages(src, idx)).forEach((p) => out.addPage(p));
  return { bytes: Buffer.from(await out.save({ useObjectStreams: true })), pages: idx.map((i) => i + 1) };
}

async function split(bytes) {
  const src = await open(bytes); const files = [];
  for (let i = 0; i < src.getPageCount(); i++) {
    const out = await PDFDocument.create({ updateMetadata: false }); const [p] = await out.copyPages(src, [i]); out.addPage(p);
    files.push(Buffer.from(await out.save({ useObjectStreams: true })));
  }
  return files;
}

async function protect(bytes, password) {
  if (!password || password.length < 4) throw new Error('Use a password of at least 4 characters');
  const doc = await open(bytes);
  doc.encrypt({ userPassword: password, ownerPassword: password, permissions: { printing: 'highResolution', copying: true, modifying: false, annotating: true, fillingForms: true } });
  return Buffer.from(await doc.save());
}

async function unlock(bytes, password = '') {
  const doc = await open(bytes, password);
  return Buffer.from(await doc.save({ useObjectStreams: true }));
}

// Remove author, title, software, XMP and other document properties.
async function scrub(bytes) {
  const doc = await open(bytes);
  for (const k of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer']) { try { doc[`set${k}`](''); } catch {} }
  try { doc.context.trailerInfo.Info = undefined; } catch {}
  doc.catalog.delete(PDFName.of('Metadata'));
  doc.catalog.delete(PDFName.of('PieceInfo'));
  return Buffer.from(await doc.save({ useObjectStreams: true, updateFieldAppearances: false }));
}

// ---------- compress: recompress big images, keep text sharp and searchable ----------
const nameOf = (v) => (v instanceof PDFName ? v.asString().replace(/^\//, '') : v instanceof PDFArray && v.size() === 1 ? nameOf(v.get(0)) : null);

function pngUnpredict(data, w, colors, predictor) {
  if (predictor < 10) return data;
  const stride = w * colors; const rows = Math.floor(data.length / (stride + 1)); const out = Buffer.alloc(rows * stride);
  for (let y = 0; y < rows; y++) {
    const f = data[y * (stride + 1)]; const src = y * (stride + 1) + 1; const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const raw = data[src + x]; const a = x >= colors ? out[dst + x - colors] : 0; const b = y ? out[dst - stride + x] : 0; const c = x >= colors && y ? out[dst - stride + x - colors] : 0;
      let v = raw;
      if (f === 1) v = raw + a; else if (f === 2) v = raw + b; else if (f === 3) v = raw + ((a + b) >> 1);
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[dst + x] = v & 255;
    }
  }
  return out;
}

function imageOf(stream) {
  const d = stream.dict; const filter = nameOf(d.get(PDFName.of('Filter')));
  const w = d.get(PDFName.of('Width'))?.asNumber?.(); const h = d.get(PDFName.of('Height'))?.asNumber?.();
  const bpc = d.get(PDFName.of('BitsPerComponent'))?.asNumber?.();
  if (!w || !h || d.get(PDFName.of('ImageMask')) || d.get(PDFName.of('Decode'))) return null;
  if (filter === 'DCTDecode') { const img = nativeImage.createFromBuffer(Buffer.from(stream.contents)); return img.isEmpty() ? null : img; }
  if (filter === 'FlateDecode' && bpc === 8) {
    let cs = d.lookup(PDFName.of('ColorSpace')); let colors = 0;
    const csName = nameOf(cs);
    if (csName === 'DeviceRGB') colors = 3; else if (csName === 'DeviceGray') colors = 1;
    else if (cs instanceof PDFArray && nameOf(cs.get(0)) === 'ICCBased') { const n = cs.lookup(1)?.dict?.get(PDFName.of('N'))?.asNumber?.(); if (n === 1 || n === 3) colors = n; }
    if (!colors) return null;
    let px = zlib.inflateSync(Buffer.from(stream.contents));
    const parms = d.lookup(PDFName.of('DecodeParms')); const pred = parms instanceof PDFDict ? parms.get(PDFName.of('Predictor'))?.asNumber?.() || 1 : 1;
    px = pngUnpredict(px, w, colors, pred);
    if (px.length < w * h * colors) return null;
    const bgra = Buffer.alloc(w * h * 4);
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      const r = px[i * colors], g = colors === 3 ? px[i * 3 + 1] : r, b = colors === 3 ? px[i * 3 + 2] : r;
      bgra[j] = b; bgra[j + 1] = g; bgra[j + 2] = r; bgra[j + 3] = 255;
    }
    return nativeImage.createFromBitmap(bgra, { width: w, height: h });
  }
  return null;
}

async function shrinkImages(bytes, longEdge, quality) {
  const doc = await open(bytes);
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || nameOf(obj.dict.get(PDFName.of('Subtype'))) !== 'Image') continue;
    if (obj.contents.length < 40000) continue; // icons, logos, line art: leave alone
    let img; try { img = imageOf(obj); } catch { img = null; }
    if (!img) continue;
    const { width, height } = img.getSize();
    const s = Math.min(1, longEdge / Math.max(width, height));
    const out = s < 1 ? img.resize({ width: Math.round(width * s), height: Math.round(height * s), quality: 'good' }) : img;
    const jpg = out.toJPEG(quality);
    if (jpg.length >= obj.contents.length * 0.9) continue;
    const d = obj.dict.clone(doc.context); const sz = out.getSize();
    d.set(PDFName.of('Width'), PDFNumber.of(sz.width)); d.set(PDFName.of('Height'), PDFNumber.of(sz.height));
    d.set(PDFName.of('Filter'), PDFName.of('DCTDecode')); d.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB')); d.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
    d.delete(PDFName.of('DecodeParms')); d.set(PDFName.of('Length'), PDFNumber.of(jpg.length));
    doc.context.assign(ref, PDFRawStream.of(d, jpg));
  }
  return Buffer.from(await doc.save({ useObjectStreams: true }));
}

// Tries gentle -> stronger settings until the file is under target (default 9 MB: fits 10 MB portals and 20 MB email).
async function compress(bytes, target = 9e6) {
  const levels = [[2200, 80], [1600, 70], [1200, 60], [900, 50]];
  let best = Buffer.from(await (await open(bytes)).save({ useObjectStreams: true }));
  for (const [edge, q] of levels) {
    if (best.length <= target && best.length < bytes.length * 0.6) break;
    const b = await shrinkImages(bytes, edge, q);
    if (b.length < best.length) best = b;
    if (best.length <= target) break;
  }
  return best.length < bytes.length ? best : Buffer.from(bytes);
}

// One image per page, fit to Letter (landscape when the photo is landscape).
async function imagesToPdf(images, { margin = 18 } = {}) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const { img } of images) {
    const { width, height } = img.getSize();
    const jpg = await doc.embedJpg(img.toJPEG(88));
    const [pw, ph] = width > height ? [LETTER[1], LETTER[0]] : LETTER;
    const s = Math.min((pw - margin * 2) / width, (ph - margin * 2) / height);
    const page = doc.addPage([pw, ph]);
    page.drawImage(jpg, { x: (pw - width * s) / 2, y: (ph - height * s) / 2, width: width * s, height: height * s });
  }
  return Buffer.from(await doc.save({ useObjectStreams: true }));
}

module.exports = { open, facts, combine, flatten, rotate, extract, split, protect, unlock, scrub, compress, imagesToPdf, parseRanges, LETTER };
