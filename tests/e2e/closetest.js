const { app, BrowserWindow, ipcMain } = require('electron');
process.argv.push(process.env.DROP);
const errors = []; process.on('uncaughtException', (e) => errors.push(e.message));
require('/home/user/leaf/src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const panel = () => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('panel.html'));
const gallery = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('gallery.html'));
app.whenReady().then(async () => {
  await wait(2500); ipcMain.emit('panel:act', {}, 0); await wait(2500);
  for (let round = 1; round <= 2; round++) {
    ipcMain.emit('panel:gallery', {}, null); await wait(1500);
    gallery().close(); await wait(500);
    panel().show(); panel().focus(); await wait(300); panel().emit('blur'); await wait(300);
    console.log(`round ${round}: gallery closed, panel blurred, panel visible=${panel().isVisible()}`);
  }
  ipcMain.emit('panel:gallery', {}, null); await wait(1500);
  console.log('gallery reopens after close:', !!gallery() && gallery().isVisible());
  console.log('uncaught errors:', JSON.stringify(errors));
  app.exit(0);
});
