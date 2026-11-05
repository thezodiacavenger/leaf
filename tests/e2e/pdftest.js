// Exercises the PDF toolkit on generated + real files and writes outputs for inspection with poppler tools.
const { app, nativeImage } = require('electron');
const fs = require('fs'); const path = require('path');
const S = '/path/to/leaf-test-data'; const O = `${S}/pdfout`;
app.whenReady().then(async () => {
  const P = require('/home/user/leaf/src/engine/pdf.js');
  const { PDFDocument, StandardFonts } = require('/home/user/leaf/node_modules/@cantoo/pdf-lib');
  fs.mkdirSync(O, { recursive: true });
  const log = (k, v) => console.log(k.padEnd(22), v);
  try {
    // 1. A fillable form (stand-in for an ACORD form)
    const f = await PDFDocument.create(); const pg = f.addPage([612, 792]); const font = await f.embedFont(StandardFonts.Helvetica);
    pg.drawText('CERTIFICATE OF LIABILITY INSURANCE (test form)', { x: 50, y: 740, size: 14, font });
    const form = f.getForm();
    [['Insured', 'Northwind Traders'], ['Policy', 'GL-0042-7781'], ['Limit', '$2,000,000']].forEach(([n, v], i) => { const t = form.createTextField(n); t.setText(v); t.addToPage(pg, { x: 50, y: 680 - i * 40, width: 300, height: 24 }); });
    const formBytes = Buffer.from(await f.save()); fs.writeFileSync(`${O}/form.pdf`, formBytes);
    log('form facts', JSON.stringify(await P.facts(formBytes)));
    // 2. A heavy "scanned" PDF from full-res photos
    const jp = `${S}/Shoot (JPEG)`; const imgs = ['sony_a7m3.jpg', 'pentax_k1.jpg', 'lumix_g9.jpg'].map((n) => ({ img: nativeImage.createFromPath(`${jp}/${n}`) }));
    const heavy = await P.imagesToPdf(imgs); fs.writeFileSync(`${O}/scan.pdf`, heavy);
    log('scan facts', JSON.stringify(await P.facts(heavy)) + ` ${(heavy.length / 1e6).toFixed(1)}MB`);
    const email = fs.readFileSync(`${S}/mail/out/HtmlSampleEmail.msg.pdf`);
    log('email facts', JSON.stringify(await P.facts(email)));
    // 3. Combine with bookmarks + flatten
    let t = Date.now();
    const comb = await P.combine([{ bytes: formBytes, title: 'ACORD 25 – certificate' }, { bytes: email, title: 'Email – HtmlSampleEmail' }, { bytes: heavy, title: 'Site photos' }]);
    fs.writeFileSync(`${O}/combined.pdf`, comb); log('combine', `${Date.now() - t}ms ${(comb.length / 1e6).toFixed(1)}MB`);
    log('combined facts', JSON.stringify(await P.facts(comb)));
    // 4. Compress
    t = Date.now(); const small = await P.compress(comb); fs.writeFileSync(`${O}/combined-compressed.pdf`, small);
    log('compress', `${(comb.length / 1e6).toFixed(1)}MB -> ${(small.length / 1e6).toFixed(2)}MB in ${Date.now() - t}ms`);
    // 5. extract / split / rotate / flatten / scrub
    const ex = await P.extract(comb, '1, 3-4'); fs.writeFileSync(`${O}/extract.pdf`, ex.bytes); log('extract', JSON.stringify(ex.pages));
    log('split', (await P.split(email)).length + ' files');
    fs.writeFileSync(`${O}/rotated.pdf`, await P.rotate(formBytes));
    fs.writeFileSync(`${O}/flat.pdf`, await P.flatten(formBytes)); log('flat facts', JSON.stringify(await P.facts(fs.readFileSync(`${O}/flat.pdf`))));
    fs.writeFileSync(`${O}/scrubbed.pdf`, await P.scrub(email));
    // 6. protect / unlock
    const locked = await P.protect(formBytes, 'Example2026'); fs.writeFileSync(`${O}/locked.pdf`, locked);
    log('locked facts', JSON.stringify(await P.facts(locked)));
    try { await P.unlock(locked, 'wrong'); log('wrong pw', 'ACCEPTED (bad)'); } catch (e) { log('wrong pw', 'rejected: ' + e.message); }
    fs.writeFileSync(`${O}/unlocked.pdf`, await P.unlock(locked, 'Example2026')); log('unlock', 'ok');
    try { await P.extract(locked, '1'); } catch (e) { log('locked extract', e.message); }
    try { P.parseRanges('5-x', 4); } catch (e) { log('bad range', e.message); }
  } catch (e) { console.log('FAILED', e.stack); }
  app.exit(0);
});
