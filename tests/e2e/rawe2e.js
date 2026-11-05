// End-to-end: drop a folder of RAWs on Leaf, check proposal, convert, verify outputs, then Photo info + zip.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs'); const path = require('path');
const SHOOT = process.env.SHOOT; const OUT = process.env.SHOTS;
process.argv = process.argv.filter((a) => !a.endsWith('rawe2e.js')); process.argv.push(SHOOT);
const errors = []; process.on('uncaughtException', (e) => errors.push(e.stack));
require('/home/user/leaf/src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const win = (n) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes(n));
const panelState = () => win('panel.html').webContents.executeJavaScript('JSON.stringify({phase: S.phase, p: S.proposal && {title: S.proposal.title, sub: S.proposal.subtitle, actions: S.proposal.actions.map(a => a.label)}, progress: S.progress, exif: S.exif && {name: S.exif.name, idx: S.exif.index, count: S.exif.count, info: S.exif.info, all: S.exif.all && S.exif.all.length}, result: S.result && {n: S.result.outputs.length, fails: S.result.failures, outs: S.result.outputs.map(o => [o.name, o.width, o.height, o.how, o.note])}})');
const shot = async (name) => { const w = win('panel.html'); fs.writeFileSync(`${OUT}/${name}.png`, (await w.capturePage()).toPNG()); };
async function until(pred, ms = 300000) { const t = Date.now(); while (Date.now() - t < ms) { const s = JSON.parse(await panelState()); if (pred(s)) return s; await wait(250); } throw new Error('timeout; last state: ' + (await panelState()).slice(0, 600)); }

app.whenReady().then(async () => {
  await wait(2500);
  try {
    let s = await until((s) => s.phase === 'proposal', 30000);
    console.log('PROPOSAL', JSON.stringify(s.p)); await shot('raw-1-proposal');
    // Photo info (action index 2)
    ipcMain.emit('panel:act', {}, 2);
    s = await until((s) => s.phase === 'exif' && s.exif.info, 30000);
    console.log('EXIF', s.exif.idx + 1, 'of', s.exif.count, '|', s.exif.info.camera, '|', s.exif.info.hero.join(' · '));
    await wait(400); await shot('raw-2-exif');
    ipcMain.emit('panel:exif-step', {}, 1); s = await until((s) => s.exif && s.exif.idx === 1 && s.exif.info, 30000);
    console.log('EXIF next ->', s.exif.info.camera, '|', s.exif.info.rows.map((r) => r[0]).join(','));
    ipcMain.emit('panel:exif-all', {}); s = await until((s) => s.exif && s.exif.all, 30000); console.log('ALL TAGS', s.exif.all);
    await wait(400); await shot('raw-3-alltags');
    ipcMain.emit('panel:exif-back', {}); s = await until((s) => s.phase === 'proposal', 5000); console.log('back to proposal ok');
    // Convert to JPEG
    const t0 = Date.now(); ipcMain.emit('panel:act', {}, 0);
    await wait(3000); await shot('raw-4-working');
    s = await until((s) => s.phase === 'done', 600000);
    console.log('DONE in', Math.round((Date.now() - t0) / 1000), 's; failures:', JSON.stringify(s.result.fails));
    for (const o of s.result.outs) console.log('  ', o.join(' | '));
    await wait(400); await shot('raw-5-done');
    console.log('uncaught:', errors.length ? errors : 'none');
  } catch (e) { console.log('TEST FAILED', e.stack, errors); }
  app.exit(0);
});
