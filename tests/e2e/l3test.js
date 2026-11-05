// Layer-3 end-to-end at engine level inside the real app (protocol + hidden windows live in main.js).
const { app } = require('electron');
const fs = require('fs'); const path = require('path');
const L = '/path/to/leaf-test-data/l3';
const M = '/path/to/leaf-test-data/mail/msg';
process.argv = process.argv.filter((a) => !a.endsWith('l3test.js'));
require('/home/user/leaf/src/main.js');
const E = '/home/user/leaf/src/engine/';
app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 1500));
  const { inspect, enrich } = require(E + 'sources'); const { propose } = require(E + 'plan'); const { run } = require(E + 'run');
  // Windows OCR can't run on Linux: stand in with fixed words placed on the page.
  const ocr = require(E + 'ocr');
  ocr.ocrImages = async (files) => ({ lang: 'en-US (mock)', pages: files.map(() => ({ w: 2550, h: 3300, words: [{ t: 'LOSS', x: 200, y: 300, w: 220, h: 60 }, { t: 'RUN', x: 440, y: 300, w: 160, h: 60 }, { t: 'GL-0042', x: 620, y: 300, w: 330, h: 60 }] })) });
  const go = async (paths, label) => {
    const src = await enrich(await inspect(paths)); const p = propose(src, { platform: 'win32' });
    console.log(`\n[${label}] ${p.title} | ${p.subtitle}\n   ${p.actions.map((a, i) => `${i ? '' : '★ '}${a.label}${a.ask ? '(asks)' : ''}${a.disabled ? '(off)' : ''}`).join(' / ')}`);
    return { src, p };
  };
  const exec = async (paths, label, id, value) => {
    const { src, p } = await go(paths, label);
    const a = p.actions.find((x) => x.id === id); if (!a) return console.log(`   !! no action ${id}`);
    const t = Date.now(); const r = await run(src, value != null ? { ...a, value } : a, { settings: {}, progress: () => {} });
    console.log(`   -> ${a.label}: ${Date.now() - t} ms${r.failures.length ? ' FAILURES ' + JSON.stringify(r.failures) : ''}`);
    r.outputs.slice(0, 6).forEach((o) => console.log(`      ${o.name}  ${(o.bytes / 1e3).toFixed(0)} KB  ${o.note || ''}`));
    if (r.outputs.length > 6) console.log(`      … +${r.outputs.length - 6} more`);
    return r;
  };
  try {
    fs.mkdirSync(`${L}/threads`, { recursive: true });
    ['TxtSampleEmail', 'RtfSampleEmailWithAttachment', 'EmailWith2Attachments'].forEach((n) => fs.copyFileSync(`${M}/${n}.msg`, `${L}/threads/${n}.msg`));
    await exec([`${M}/HtmlSampleEmailWithAttachment.msg`], 'one email', 'mail-pdf');
    await exec([`${M}/EmailWithAttachments.msg`], 'one email', 'mail-attach');
    await exec([`${L}/threads`], 'three emails', 'mail-onepdf');
    await exec([`${L}/winmail.dat`], 'winmail', 'mail-attach');
    await exec([`${L}/package`], 'package', 'combine');
    await exec([`${L}/scan.pdf`], 'scanned pdf', 'pdf-compress');
    await exec([`${L}/scan.pdf`], 'scanned pdf', 'pdf-extract', '2-3');
    const locked = await exec([`${L}/scan (compressed).pdf`], 'small pdf', 'pdf-protect', 'Claims2026');
    await exec([locked.outputs[0].path], 'locked pdf', 'pdf-unlock', 'Claims2026');
    await exec([`${L}/package/01-acord.pdf`], 'form', 'pdf-flatten');
    await exec([`${L}/inventory.csv`], 'csv', 'csv-xlsx');
    await exec([`${L}/inventory.csv`], 'csv', 'csv-clean');
    await go([`${L}/package/01-acord.pdf`, `${L}/inventory.csv`], 'pdf+csv');
    await exec(['/path/to/leaf-test-data/Shoot (JPEG)'], 'photo folder', 'photo-report');
    await exec([`${L}/fax/fax.tif`], 'fax tiff', 'tiff-pdf');
    await exec([`${L}/scan (compressed).pdf`], 'scanned pdf (OCR, mocked engine)', 'ocr');
    await exec([`${L}/fax/fax.tif`], 'fax (OCR, mocked engine)', 'ocr');
    await exec([`${L}/package/03-photo.jpg`], 'photo', 'clean');
  } catch (e) { console.log('TEST FAILED', e.stack); }
  app.exit(0);
});
