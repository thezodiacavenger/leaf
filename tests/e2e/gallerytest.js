// Gallery keyboard flow on the current Electron: convert HEIC zip, open gallery, arrow + Space -> full screen, Esc back.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const SHOTS = '/path/to/leaf-test-data/shots';
process.argv = process.argv.filter((a) => !a.endsWith('gallerytest.js')); process.argv.push(process.env.DROP);
require('/home/user/leaf/src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const find = (n) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes(n));
setTimeout(() => { console.log('WATCHDOG timeout'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  try {
    await wait(3000); ipcMain.emit('panel:act', {}, 0); await wait(3000);
    ipcMain.emit('panel:gallery', {}, null); await wait(2500);
    const g = find('gallery.html'); console.log('gallery window:', !!g, g && g.isVisible());
    g.focus(); g.webContents.focus(); await wait(300);
    const js = (c) => g.webContents.executeJavaScript(c);
    console.log('tiles:', await js('document.querySelectorAll(".tile").length'), 'active:', await js('document.activeElement && document.activeElement.className'));
    g.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' }); g.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' }); await wait(400);
    console.log('after Right, cur =', await js('cur'));
    g.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); g.webContents.sendInputEvent({ type: 'char', keyCode: ' ' }); g.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' }); await wait(1200);
    console.log('after Space: lightbox open =', await js("document.getElementById('lb').classList.contains('open')"), 'fullscreen =', g.isFullScreen());
    fs.writeFileSync(`${SHOTS}/e44-lightbox.png`, (await g.capturePage()).toPNG());
    g.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'I' }); await wait(1500);
    console.log('info sheet:', await js("document.getElementById('lb').classList.contains('info')"), (await js("document.getElementById('sheet').innerText")).split('\n').slice(0, 3).join(' | '));
    g.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); await wait(800);
    console.log('after Esc: lightbox open =', await js("document.getElementById('lb').classList.contains('open')"), 'fullscreen =', g.isFullScreen());
  } catch (e) { console.log('FAILED', e.stack); }
  app.exit(0);
});
