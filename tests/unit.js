// Self-contained engine tests: `npm test` (on Linux CI: `xvfb-run -a npm test`).
// Generates every fixture itself, so no sample files are needed. Exits non-zero on failure.
const { app, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const E = path.join(__dirname, '..', 'src', 'engine');
const eng = (m) => require(path.join(E, m));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-test-'));
const results = [];
async function t(name, fn) {
  const start = Date.now();
  try { await fn(); results.push(['✓', name, Date.now() - start]); } catch (e) { results.push(['✗', name, e.stack || e.message]); }
}

// --- fixture builders ---
function jpeg(w = 640, h = 480) {
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i * 4] = (i % w) & 255; px[i * 4 + 1] = (i / w) & 255; px[i * 4 + 2] = 128; px[i * 4 + 3] = 255; }
  return nativeImage.createFromBitmap(px, { width: w, height: h }).toJPEG(85);
}
async function formPdf() {
  const { PDFDocument, StandardFonts } = require('@cantoo/pdf-lib');
  const d = await PDFDocument.create(); const p = d.addPage([612, 792]); const f = await d.embedFont(StandardFonts.Helvetica);
  p.drawText('Test certificate', { x: 50, y: 740, size: 14, font: f });
  const t1 = d.getForm().createTextField('Insured'); t1.setText('Northwind Traders'); t1.addToPage(p, { x: 50, y: 680, width: 300, height: 24 });
  return Buffer.from(await d.save());
}
function eml() {
  const att = Buffer.from('hello attachment').toString('base64');
  return Buffer.from([
    'From: Ana Lopez <ana@example.com>', 'To: Sam <sam@example.com>', 'Subject: RE: Renewal docs', 'Date: Tue, 03 Mar 2026 10:00:00 -0500',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b1"', '',
    '--b1', 'Content-Type: text/html; charset=utf-8', '', '<html><body><p>Please find the <b>loss runs</b> attached.</p></body></html>',
    '--b1', 'Content-Type: text/plain; name="note.txt"', 'Content-Disposition: attachment; filename="note.txt"', 'Content-Transfer-Encoding: base64', '', att,
    '--b1--', '',
  ].join('\r\n'));
}
function tnef(files) {
  const parts = [Buffer.from([0x78, 0x9f, 0x3e, 0x22, 0x01, 0x00])];
  const attr = (level, id, data) => {
    const h = Buffer.alloc(9); h[0] = level; h.writeUInt32LE(id, 1); h.writeUInt32LE(data.length, 5);
    const sum = Buffer.alloc(2); sum.writeUInt16LE(data.reduce((a, b) => (a + b) & 0xffff, 0)); parts.push(h, data, sum);
  };
  for (const [name, body] of files) { attr(2, 0x00069002, Buffer.alloc(14)); attr(2, 0x00018010, Buffer.from(name + '\0')); attr(2, 0x0006800f, Buffer.from(body)); }
  return Buffer.concat(parts);
}
const item = (name, extra = {}) => {
  const { kindOf } = eng('sources'); const ext = path.extname(name).toLowerCase();
  return { rel: name, name, ext, kind: kindOf(ext, name), size: 1000, read: async () => Buffer.alloc(0), ...extra };
};
const src = (items, type = 'folder', p = path.join(tmp, 'drop')) => [{ type, path: p, label: path.basename(p), items }];

app.whenReady().then(async () => {
  const { propose } = eng('plan');
  const pdf = eng('pdf');

  await t('plan: HEIC zip with a notes.txt → Convert to JPEG', () => {
    const p = propose(src([item('a.heic'), item('b.heic'), item('notes.txt')], 'zip', path.join(tmp, 'Trip.zip')), { platform: 'win32' });
    assert.equal(p.actions[0].id, 'convert'); assert.equal(p.actions[0].target, 'jpeg');
  });
  await t('plan: PDF + email + photo → Combine into one PDF', () => {
    assert.equal(propose(src([item('a.pdf'), item('b.msg'), item('c.jpg')]), { platform: 'win32' }).actions[0].id, 'combine');
  });
  await t('plan: many photos + one form → photo action first, Combine offered', () => {
    const p = propose(src([...Array(8)].map((_, i) => item(`p${i}.jpg`)).concat(item('form.pdf'))), { platform: 'win32' });
    assert.equal(p.actions[0].id, 'shrink'); assert.ok(p.actions.some((a) => a.id === 'combine'));
  });
  await t('plan: locked PDF → Remove password (asks)', () => {
    const p = propose(src([item('x.pdf', { facts: { pages: 2, encrypted: true, needsPassword: true } })], 'file'), { platform: 'win32' });
    assert.equal(p.actions[0].id, 'pdf-unlock'); assert.ok(p.actions[0].ask);
  });
  await t('plan: winmail.dat / CSV / RAW / Office off-Windows', () => {
    assert.equal(propose(src([item('winmail.dat')], 'file')).actions[0].id, 'mail-attach');
    assert.equal(propose(src([item('stock.csv')], 'file')).actions[0].id, 'csv-xlsx');
    assert.equal(propose(src([item('a.CR3'), item('b.ARW')])).actions[0].target, 'jpeg');
    assert.ok(propose(src([item('book.xlsx')], 'file'), { platform: 'linux' }).actions.every((a) => a.disabled || a.id === 'zip'));
  });

  await t('sheet: CSV → XLSX keeps leading zeros, numbers stay numbers', async () => {
    const csv = path.join(tmp, 'inv.csv'); fs.writeFileSync(csv, 'SKU,Qty,Received\r\n00123,3,03/04/2026\r\n0456,12,2026-03-05\r\n');
    const out = path.join(tmp, 'inv.xlsx'); const r = await eng('sheet').csvToXlsx(csv, out, 'inv');
    assert.equal(r.textCols, 2);
    const yauzl = require('yauzl');
    const xml = await new Promise((res, rej) => yauzl.open(out, { lazyEntries: true }, (e, z) => { if (e) return rej(e); z.on('entry', (en) => { if (en.fileName === 'xl/worksheets/sheet1.xml') z.openReadStream(en, (er, s) => { let b = ''; s.on('data', (c) => { b += c; }); s.on('end', () => res(b)); }); else z.readEntry(); }); z.readEntry(); }));
    assert.match(xml, />00123</); assert.match(xml, /<v>12<\/v>/); assert.match(xml, />03\/04\/2026</);
  });

  await t('pdf: facts, flatten, combine + bookmarks, extract, rotate', async () => {
    const form = await formPdf();
    assert.equal((await pdf.facts(form)).hasForm, true);
    assert.equal((await pdf.facts(await pdf.flatten(form))).hasForm, false);
    const imgPdf = await pdf.imagesToPdf([{ img: nativeImage.createFromBuffer(jpeg()) }]);
    const both = await pdf.combine([{ bytes: form, title: 'Form' }, { bytes: imgPdf, title: 'Photo' }]);
    assert.equal((await pdf.facts(both)).pages, 2); assert.ok(both.includes(Buffer.from('/Outlines')));
    assert.deepEqual((await pdf.extract(both, '2')).pages, [2]);
    assert.ok((await pdf.rotate(form)).length > 0);
    assert.throws(() => pdf.parseRanges('5-x', 3));
  });
  await t('pdf: password protect → wrong password rejected → unlock', async () => {
    const locked = await pdf.protect(await formPdf(), 'Secret123');
    assert.equal((await pdf.facts(locked)).needsPassword, true);
    await assert.rejects(pdf.unlock(locked, 'nope'));
    assert.equal((await pdf.facts(await pdf.unlock(locked, 'Secret123'))).encrypted, false);
  });
  await t('pdf: compress shrinks a photo-heavy PDF', async () => {
    const big = await pdf.imagesToPdf([0, 1, 2].map(() => ({ img: nativeImage.createFromBuffer(jpeg(3000, 2000)) })));
    assert.ok((await pdf.compress(big)).length < big.length);
  });

  await t('mail: .eml parses and renders to PDF with header', async () => {
    const mail = eng('mail'); const m = await mail.parseMail(eml());
    assert.equal(m.subject, 'RE: Renewal docs'); assert.match(m.from, /ana@example\.com/); assert.equal(m.attachments[0].name, 'note.txt');
    assert.equal(mail.safeName('RE: a/b?'), 'RE: a b'.replace(':', ' ').replace(/\s+/g, ' ').trim() === 'RE a b' ? 'RE a b' : mail.safeName('RE: a/b?'));
    const bytes = await eng('render').htmlToPdf(mail.toHtml(m), { footer: m.subject });
    assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
  });
  await t('mail: winmail.dat (TNEF) attachments extracted', async () => {
    const m = await eng('mail').parseMail(tnef([['report.pdf', 'PDFDATA'], ['photo.jpg', 'JPG']]));
    assert.deepEqual(m.attachments.map((a) => a.name), ['report.pdf', 'photo.jpg']);
    assert.equal(m.attachments[0].data.toString(), 'PDFDATA');
  });

  await t('raw: finds the biggest embedded JPEG in a RAW-like file', () => {
    const buf = Buffer.concat([Buffer.alloc(5000, 7), jpeg(160, 120), Buffer.alloc(3000, 1), jpeg(800, 600), Buffer.alloc(100)]);
    const j = eng('raw').largestJpeg(buf); assert.equal(j.width, 800); assert.equal(j.height, 600);
  });
  await t('raw: rotate 90° swaps dimensions', () => {
    const r = eng('raw').rotate(Buffer.alloc(4 * 6 * 4), 4, 6, 6); assert.equal(r.width, 6); assert.equal(r.height, 4);
  });
  await t('report: TIFF pages decode with physical size', () => {
    const UTIF = require('utif'); const w = 200; const h = 100; const rgba = new Uint8Array(w * h * 4).fill(255);
    const tif = Buffer.from(UTIF.encodeImage(rgba, w, h)); const pages = eng('report').tiffPages(tif);
    assert.equal(pages.length, 1); assert.ok(pages[0].wPt > 0 && pages[0].hPt > 0);
  });

  require(path.join(E, 'render')).close();
  for (const [ok, name, info] of results) console.log(`${ok} ${name}${ok === '✓' ? ` (${info} ms)` : `\n    ${String(info).split('\n').slice(0, 4).join('\n    ')}`}`);
  const failed = results.filter((r) => r[0] === '✗').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
});
