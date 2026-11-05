// First run on a clean profile: welcome offer -> create Leaf Pile -> save a file into it -> suggestion -> convert -> no echo.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs'); const path = require('path'); const os = require('os');
const S = '/path/to/leaf-test-data';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-profile-')); app.setPath('userData', profile);
const desk = path.join(S, 'Desktop'); fs.rmSync(desk, { recursive: true, force: true }); fs.mkdirSync(desk); app.setPath('desktop', desk);
process.argv = process.argv.filter((a) => !a.endsWith('piletest.js'));
require('/home/user/leaf/src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const panel = () => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('panel.html'));
const st = () => panel().webContents.executeJavaScript('JSON.stringify({phase:S.phase, offer:S.pileOffer, title:S.proposal&&S.proposal.title, actions:S.proposal&&S.proposal.actions.map(a=>a.label).slice(0,3)})').then(JSON.parse);
app.whenReady().then(async () => {
  try {
    await wait(3000);
    console.log('first run:', JSON.stringify(await st()), 'panel visible', panel().isVisible());
    fs.writeFileSync(`${S}/shots/pile-offer.png`, (await panel().capturePage()).toPNG());
    ipcMain.emit('panel:pile', {}, true); await wait(800);
    const pile = path.join(desk, 'Leaf Pile');
    console.log('pile exists:', fs.existsSync(pile), 'settings:', fs.readFileSync(path.join(profile, 'settings.json'), 'utf8').replace(/\s+/g, ' '));
    // simulate Outlook "Save attachment" into the pile, written in two chunks
    const src = fs.readFileSync(`${S}/mail/msg/EmailWithAttachments.msg`);
    fs.writeFileSync(path.join(pile, 'Claim email.msg'), src.subarray(0, 50000)); await wait(400);
    fs.appendFileSync(path.join(pile, 'Claim email.msg'), src.subarray(50000));
    await wait(5000);
    let s = await st(); console.log('after save:', JSON.stringify(s));
    ipcMain.emit('panel:act', {}, 0); await wait(4000);
    s = await st(); console.log('after convert:', s.phase, fs.readdirSync(pile));
    await wait(5000);
    s = await st(); console.log('5 s later (should still be done, not a new proposal):', s.phase);
  } catch (e) { console.log('FAILED', e.stack); }
  app.exit(0);
});
