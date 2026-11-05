const { app } = require('electron');
app.whenReady().then(async () => {
  const raw = require('/home/user/leaf/src/engine/raw.js');
  const t = setTimeout(() => { console.log('HUNG after 20s'); app.exit(1); }, 20000);
  try { const i = await raw.photoInfo(process.env.F); console.log('OK', i.camera, i.hero); } catch (e) { console.log('ERR', e.stack); }
  clearTimeout(t); await raw.endExiftool(); app.exit(0);
});
