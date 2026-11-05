const { app, BrowserWindow, ipcMain } = require('electron');
require('/home/user/leaf/src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let got = null; ipcMain.prependListener('leaf:drop', (_e, paths) => { got = paths; });
app.whenReady().then(async () => {
  await wait(2000);
  const leafW = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('leaf.html'));
  const panelW = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('panel.html'));
  await leafW.webContents.executeJavaScript(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['a'], 'photo.heic'));
    dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
  await wait(800);
  console.log('paths received by main:', JSON.stringify(got));
  console.log('panel visible:', panelW.isVisible());
  console.log('panel says:', await panelW.webContents.executeJavaScript("document.querySelector('h1')?.textContent + ' | ' + document.querySelector('.sub')?.textContent"));
  app.exit(0);
});
