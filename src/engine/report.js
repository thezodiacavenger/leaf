// Photo report PDF (claims, damage, RMAs, site visits) and multi-page TIFF (fax) -> PDF.
const path = require('node:path');
const { nativeImage } = require('electron');
const { PDFDocument, StandardFonts, rgb } = require('@cantoo/pdf-lib');
const raw = require('./raw');

const LETTER = [612, 792];

// Standard PDF fonts only cover Western European characters; anything else becomes '?'.
function safe(font, s) {
  s = String(s || '');
  try { font.encodeText(s); return s; } catch { return [...s].map((ch) => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join(''); }
}
function fitText(font, s, size, max) { s = safe(font, s); while (s.length > 3 && font.widthOfTextAtSize(s, size) > max) s = s.slice(0, -2); return s; }

async function photoReport(sources, items, ctx, h, emit) {
  if (!items.length) throw new Error('No photos to put in a report');
  // Read info + decode in parallel, then order by date taken (falls back to name).
  const shots = new Array(items.length);
  await h.each(items, 3, ctx, async (it, n) => {
    const { img, metaSrc } = await h.toImage(it);
    let info = null; try { info = metaSrc ? await raw.photoInfo(metaSrc) : null; } catch {}
    const taken = info?.rows.find((r) => r[0] === 'Taken')?.[1] || '';
    shots[n] = { it, jpg: h.fit(img, 1600).toJPEG(82), size: img.getSize(), info, taken, when: info?.takenRaw || 0 };
  });
  const list = shots.filter(Boolean).sort((a, b) => (a.when && b.when ? a.when - b.when : a.it.rel.localeCompare(b.it.rel, undefined, { numeric: true })));

  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica); const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const title = sources.length === 1 && sources[0].type !== 'file' ? path.parse(sources[0].path).name : path.basename(path.dirname(sources[0].path)) || 'Photos';
  const made = new Date().toLocaleDateString('en-CA', { dateStyle: 'long' });
  const M = 40; const W = LETTER[0] - M * 2; const slotH = (LETTER[1] - M * 2 - 30) / 2;
  const pages = Math.ceil(list.length / 2);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage(LETTER);
    page.drawText(fitText(bold, `${title} — photo report`, 11, W - 120), { x: M, y: LETTER[1] - M + 6, size: 11, font: bold, color: rgb(0.1, 0.1, 0.12) });
    page.drawText(`${made} · page ${p + 1} of ${pages}`, { x: LETTER[0] - M - font.widthOfTextAtSize(`${made} · page ${p + 1} of ${pages}`, 8.5), y: LETTER[1] - M + 7, size: 8.5, font, color: rgb(0.45, 0.45, 0.5) });
    page.drawLine({ start: { x: M, y: LETTER[1] - M }, end: { x: LETTER[0] - M, y: LETTER[1] - M }, thickness: 0.8, color: rgb(0.18, 0.42, 1) });
    for (let k = 0; k < 2; k++) {
      const s = list[p * 2 + k]; if (!s) break;
      const top = LETTER[1] - M - 14 - k * (slotH + 8); const capH = 38; const boxH = slotH - capH;
      const im = await doc.embedJpg(s.jpg); const sc = Math.min(W / im.width, boxH / im.height);
      const w = im.width * sc; const hgt = im.height * sc;
      page.drawImage(im, { x: M + (W - w) / 2, y: top - boxH + (boxH - hgt) / 2, width: w, height: hgt });
      const n = p * 2 + k + 1;
      const line1 = fitText(bold, `${n}. ${s.it.name}`, 9.5, W);
      const bits = [s.taken && `Taken ${s.taken}`, s.info && s.info.camera !== s.it.name && s.info.camera, s.info?.rows.find((r) => r[0] === 'Lens')?.[1]].filter(Boolean);
      const gps = s.info?.gps ? `GPS ${s.info.gps.lat.toFixed(5)}, ${s.info.gps.lon.toFixed(5)}` : 'No location recorded';
      page.drawText(line1, { x: M, y: top - boxH - 13, size: 9.5, font: bold });
      page.drawText(fitText(font, [...bits, gps].join('  ·  '), 8.5, W), { x: M, y: top - boxH - 26, size: 8.5, font, color: rgb(0.3, 0.3, 0.35) });
    }
  }
  const bytes = Buffer.from(await doc.save({ useObjectStreams: true }));
  return emit(ctx, h, path.join(path.dirname(sources[0].path), `${title} photo report.pdf`), bytes, { note: `${list.length} photos, by date taken, with captions` });
}

// ---------- TIFF / fax ----------
function tiffIfds(buf) { const UTIF = require('utif'); return UTIF.decode(buf).filter((f) => f.t256 && f.t257); }
const tiffPageCount = (buf) => tiffIfds(buf).length;

// Each page with its physical size (faxes use unequal X/Y resolution, e.g. 204×98 dpi).
function tiffPages(buf) {
  const UTIF = require('utif');
  return tiffIfds(buf).map((ifd) => {
    UTIF.decodeImage(buf, ifd);
    const rgba = UTIF.toRGBA8(ifd); const { width, height } = ifd;
    for (let i = 0; i < rgba.length; i += 4) { const r = rgba[i]; rgba[i] = rgba[i + 2]; rgba[i + 2] = r; }
    const unit = ifd.t296 ? ifd.t296[0] : 2; const toInch = unit === 3 ? 2.54 : 1;
    const res = (t) => (t && t[0] ? (Array.isArray(t[0]) ? t[0][0] / (t[0][1] || 1) : t[0]) : 0);
    const xr = res(ifd.t282) * toInch || 200; const yr = res(ifd.t283) * toInch || xr;
    return { img: nativeImage.createFromBitmap(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { width, height }), wPt: (width / xr) * 72, hPt: (height / yr) * 72, bilevel: (ifd.t258 ? ifd.t258[0] : 8) === 1 };
  });
}

async function pagesToPdf(pages) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const pg of pages) {
    const im = pg.bilevel ? await doc.embedPng(pg.img.toPNG()) : await doc.embedJpg(pg.img.toJPEG(85));
    doc.addPage([pg.wPt, pg.hPt]).drawImage(im, { x: 0, y: 0, width: pg.wPt, height: pg.hPt });
  }
  return Buffer.from(await doc.save({ useObjectStreams: true }));
}

module.exports = { photoReport, tiffPages, tiffPageCount, pagesToPdf, safe, fitText };
