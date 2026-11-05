// Leaf — main process. Owns windows, state, and the conversion engine.
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, nativeTheme, shell, clipboard, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { inspect, enrich, isPhoto } = require('./engine/sources');
const raw = require('./engine/raw');
const darkroom = require('./engine/darkroom');
const { propose, mb } = require('./engine/plan');
const engine = require('./engine/run');
const office = require('./engine/office');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
// Safety net: unexpected errors go to %APPDATA%\Leaf\leaf.log instead of an error dialog.
const logError = (err) => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'leaf.log'), `${new Date().toISOString()} ${err && err.stack || err}\n`); } catch {} };
process.on('uncaughtException', logError);
process.on('unhandledRejection', logError);
protocol.registerSchemesAsPrivileged([{ scheme: 'leaf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

const UI = path.join(__dirname, 'ui');
const LEAF = 112; const PANEL_W = 380; const MARGIN = 16;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { glass: 'auto', jpegQuality: 90, position: null };
try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); } catch {}
const save = () => fs.promises.writeFile(settingsFile(), JSON.stringify(settings, null, 2)).catch(() => {});

// System acrylic (backgroundMaterial) exists from Windows 11 22H2 (build 22621). Windows 10 and 11 21H2 get drawn glass.
const winBuild = process.platform === 'win32' ? Number(os.release().split('.')[2] || 0) : 0;
const systemGlass = settings.glass !== 'css' && winBuild >= 22621;
// The portable .exe unpacks to a temp folder each launch; startup/Send To must point at the real file.
const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;

let leafWin; let panelWin; let galleryWin; let tray;
const alive = (w) => !!w && !w.isDestroyed(); // a closed window throws on any call
let sources = null; let ctx = null;
const allowed = new Set(); // files the gallery may read through leaf://
const sourceOf = new Map(); // converted file -> original photo (for Photo info)
let exifFiles = [];
const galleryResults = new Map(); // gallery webContents id -> result it shows        // photos the Photo info view can page through
let state = { phase: 'idle', recent: [] };

function broadcast() {
  const s = { ...state, systemGlass };
  for (const w of [leafWin, panelWin]) if (alive(w)) w.webContents.send('state', s);
}
function setState(patch) { state = { ...state, ...patch }; broadcast(); }

function glassWindow(opts) {
  return new BrowserWindow({
    frame: false, show: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: true, backgroundColor: '#00000000',
    ...(systemGlass ? { backgroundMaterial: 'acrylic' } : { transparent: true }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
    ...opts,
  });
}

function leafHome() {
  const wa = screen.getPrimaryDisplay().workArea;
  const p = settings.position;
  if (p && screen.getAllDisplays().some((d) => p.x >= d.workArea.x && p.x < d.workArea.x + d.workArea.width && p.y >= d.workArea.y && p.y < d.workArea.y + d.workArea.height)) return p;
  return { x: wa.x + wa.width - LEAF - MARGIN / 2, y: wa.y + wa.height - LEAF - MARGIN / 2 };
}

function createLeaf() {
  const { x, y } = leafHome();
  leafWin = new BrowserWindow({
    x, y, width: LEAF, height: LEAF, frame: false, transparent: true, resizable: false, skipTaskbar: true, hasShadow: false,
    alwaysOnTop: true, focusable: true, maximizable: false, fullscreenable: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  leafWin.setAlwaysOnTop(true, 'floating');
  leafWin.loadFile(path.join(UI, 'leaf.html'));
  leafWin.once('ready-to-show', () => leafWin.showInactive());
}

function createPanel() {
  panelWin = glassWindow({ width: PANEL_W, height: 220, alwaysOnTop: true });
  panelWin.setAlwaysOnTop(true, 'floating');
  panelWin.loadFile(path.join(UI, 'panel.html'), { query: { glass: systemGlass ? 'system' : 'css' } });
  panelWin.on('blur', () => { if (state.phase !== 'working' && !(alive(galleryWin) && galleryWin.isFocused())) hidePanel(); });
}

function placePanel(height = panelWin.getBounds().height) {
  const lb = leafWin.getBounds();
  const wa = screen.getDisplayMatching(lb).workArea;
  const right = lb.x + lb.width / 2 > wa.x + wa.width / 2;
  const bottom = lb.y + lb.height / 2 > wa.y + wa.height / 2;
  let x = right ? lb.x - PANEL_W + 8 : lb.x + lb.width - 8;
  let y = bottom ? lb.y + lb.height - height - 8 : lb.y + 8;
  x = Math.max(wa.x + MARGIN, Math.min(x, wa.x + wa.width - PANEL_W - MARGIN));
  y = Math.max(wa.y + MARGIN, Math.min(y, wa.y + wa.height - height - MARGIN));
  panelWin.setBounds({ x: Math.round(x), y: Math.round(y), width: PANEL_W, height: Math.round(height) });
}
function showPanel() { placePanel(); panelWin.show(); panelWin.focus(); setState({ unseen: false }); }
function hidePanel() { if (alive(panelWin) && panelWin.isVisible()) panelWin.hide(); }

// ---------- the flow: drop -> propose -> run -> done ----------
async function handleDrop(paths, { auto = false } = {}) {
  paths = (paths || []).filter((p) => p && fs.existsSync(p));
  if (!paths.length) {
    setState({ phase: 'error', error: 'Leaf couldn’t see a file in that drop. Try dragging it from File Explorer.' });
    showPanel(); return;
  }
  if (state.phase === 'working') { showPanel(); return; }
  sources?.forEach((s) => s.close && s.close());
  setState({ phase: 'reading', proposal: null, result: null });
  showPanel();
  try {
    sources = await enrich(await inspect(paths));
    setState({ phase: 'proposal', proposal: propose(sources) });
    if (auto && !state.proposal.actions[0].disabled) act(0);
  } catch (e) {
    setState({ phase: 'error', error: `Couldn't open that: ${e.message}` });
  }
}

async function act(index, value) {
  const picked = state.proposal?.actions?.[index];
  if (!picked || picked.disabled || !sources) return;
  const action = value != null ? { ...picked, value } : picked;
  if (action.id === 'exif') {
    exifFiles = sources.flatMap((s) => s.items).filter(isPhoto).map((it) => ({ name: it.name, get: () => raw.onDisk(it) }));
    return showExif(0, true);
  }
  ctx = { settings, cancelled: false, progress: throttle((done, total, name) => setState({ progress: { done, total, name } }), 60) };
  setState({ phase: 'working', action: action.label, progress: { done: 0, total: 0 } });
  try {
    const result = await engine.run(sources, action, ctx);
    sources = null;
    result.outputs.forEach((o) => allowed.add(o.path));
    for (const p of [...result.outputs.map((o) => o.path), ...result.dirs]) { const rel = path.relative(pileDir(), p); if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) pileIgnore.add(rel.split(path.sep)[0]); }
    result.outputs.forEach((o) => { if (o.thumb) allowed.add(o.thumb); if (o.source) sourceOf.set(o.path, o.source); });
    result.title = result.dirs[0] ? path.basename(result.dirs[0]) : result.outputs[0] ? path.basename(path.dirname(result.outputs[0].path)) : '';
    result.size = mb(result.outputs.reduce((a, o) => a + (o.bytes || 0), 0));
    result.images = result.outputs.filter((o) => o.thumb).length;
    const recent = result.outputs.length ? [{ title: result.title, images: result.images, count: result.outputs.length, result, at: Date.now() }, ...state.recent].slice(0, 4) : state.recent;
    setState({ phase: 'done', result, recent, unseen: !panelWin.isVisible() });
    if (action.open && result.outputs[0] && !result.failures.length) shell.openPath(result.outputs[0].path);
    if (!panelWin.isVisible()) leafWin.webContents.send('nudge');
  } catch (e) {
    setState({ phase: 'error', error: e.message });
  }
}

// ---------- Photo info ----------
async function showExif(index, back = state.exif?.back) {
  const f = exifFiles[index]; if (!f) return;
  const base = { index, count: exifFiles.length, name: f.name, back };
  setState({ phase: 'exif', exif: { ...base, loading: true } });
  try {
    const info = await raw.photoInfo(await f.get());
    if (state.phase === 'exif' && state.exif.index === index) setState({ exif: { ...base, info } });
  } catch (e) {
    if (state.phase === 'exif' && state.exif.index === index) setState({ exif: { ...base, error: `Couldn't read this photo's info (${e.message})` } });
  }
}
const exifText = (info) => [info.camera, info.hero.join('  '), ...info.rows.map(([k, v]) => `${k}: ${v}`)].join('\n');

// ---------- Leaf Pile: an optional desktop folder that works like a drop target ----------
const { execFile } = require('node:child_process');
const pileDir = () => path.join(app.getPath('desktop'), 'Leaf Pile');
let pileWatcher = null; const pileIgnore = new Set();
function makePile() {
  const dir = pileDir(); fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const ini = path.join(dir, 'desktop.ini'); const ico = path.join(dir, '.leaf-pile.ico');
    const run = (cmd, args) => new Promise((r) => execFile(cmd, args, { windowsHide: true }, () => r()));
    (async () => {
      await run('attrib', ['-h', '-s', ini]); await run('attrib', ['-h', ico]); // hidden/system files can't be overwritten
      fs.writeFileSync(ico, fs.readFileSync(path.join(UI, 'leaf-pile.ico')));
      fs.writeFileSync(ini, '[.ShellClassInfo]\r\nIconResource=.leaf-pile.ico,0\r\nInfoTip=Drop or save files here and Leaf picks them up.\r\n[ViewState]\r\nMode=\r\nVid=\r\nFolderType=Generic\r\n');
      await run('attrib', ['+h', '+s', ini]); await run('attrib', ['+h', ico]); await run('attrib', ['+r', dir]); // +r tells Explorer to read desktop.ini
      await run('ie4uinit.exe', ['-show']); // refresh the icon cache (Windows 10/11)
    })().catch(logError);
  }
  watchPile();
}
function watchPile() {
  if (pileWatcher || !fs.existsSync(pileDir())) return;
  const dir = pileDir(); const known = new Set(fs.readdirSync(dir)); const fresh = new Set(); let timer;
  const flush = async () => {
    if (state.phase === 'working' || state.phase === 'reading') { timer = setTimeout(flush, 1500); return; }
    const names = [...fresh].filter((n) => !known.has(n) && !pileIgnore.has(n)); fresh.clear();
    const paths = names.map((n) => path.join(dir, n)).filter((p) => fs.existsSync(p));
    // Wait until files stop growing (downloads, scanner output, Outlook "Save as").
    const size = (p) => { try { const st = fs.statSync(p); return st.isDirectory() ? -1 : st.size; } catch { return -2; } };
    for (let i = 0; i < 20; i++) { const a = paths.map(size); await new Promise((r) => setTimeout(r, 700)); if (paths.map(size).every((v, k) => v === a[k])) break; }
    names.forEach((n) => known.add(n));
    if (paths.length) handleDrop(paths);
  };
  try {
    pileWatcher = fs.watch(dir, (_ev, name) => {
      if (!name || name.includes(path.sep) || /^(desktop\.ini|\.leaf-pile\.ico)$/i.test(name) || /^~\$|^\.|\.(tmp|crdownload|part|partial|download|opdownload)$/i.test(name)) return;
      fresh.add(name); clearTimeout(timer); timer = setTimeout(flush, 1500);
    });
    pileWatcher.on('error', () => { pileWatcher = null; });
  } catch { pileWatcher = null; }
}
function setPile(on) {
  settings.pile = !!on; save();
  if (on) makePile(); else if (pileWatcher) { pileWatcher.close(); pileWatcher = null; }
  setState({ pileOffer: false }); tray?.setContextMenu(trayMenu());
}

function throttle(fn, ms) {
  let last = 0; let t;
  return (...a) => { const now = Date.now(); clearTimeout(t); if (now - last > ms || a[0] === a[1]) { last = now; fn(...a); } else t = setTimeout(() => { last = Date.now(); fn(...a); }, ms); };
}

// ---------- gallery ----------
function openGallery(result = state.result) {
  if (!result) return;
  hidePanel();
  if (!alive(galleryWin)) {
    const wa = screen.getDisplayMatching(leafWin.getBounds()).workArea;
    const w = Math.min(1240, wa.width - 80); const h = Math.min(820, wa.height - 80);
    galleryWin = glassWindow({ width: w, height: h, x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 2),
      resizable: true, minimizable: true, maximizable: true, fullscreenable: true, skipTaskbar: false, minWidth: 560, minHeight: 420, title: 'Leaf' });
    galleryWin.loadFile(path.join(UI, 'gallery.html'), { query: { glass: systemGlass ? 'system' : 'css' } });
    galleryWin.once('ready-to-show', () => alive(galleryWin) && galleryWin.show());
    const wcId = galleryWin.webContents.id;
    galleryWin.on('closed', () => { galleryWin = null; galleryResults.delete(wcId); });
  } else galleryWin.focus();
  galleryResults.set(galleryWin.webContents.id, result);
  galleryWin.webContents.send('gallery', result);
}

async function emailFiles(files, { shrink = false } = {}) {
  const list = shrink ? await engine.emailCopies(files) : files;
  const subject = files.length === 1 ? path.parse(files[0]).name : `${files.length} files`;
  return office.composeMail({ attachments: list, subject });
}

// ---------- IPC ----------
ipcMain.on('leaf:drop', (_e, paths) => handleDrop(paths));
ipcMain.on('leaf:click', () => (panelWin.isVisible() ? hidePanel() : showPanel()));
ipcMain.on('leaf:move', (_e, { x, y }) => { leafWin.setPosition(Math.round(x), Math.round(y)); if (panelWin.isVisible()) placePanel(); });
ipcMain.on('leaf:moved', () => { const [x, y] = leafWin.getPosition(); settings.position = { x, y }; save(); });
ipcMain.handle('leaf:pos', () => leafWin.getPosition());
ipcMain.on('panel:height', (_e, h) => placePanel(Math.min(640, Math.max(120, h))));
ipcMain.on('panel:act', (_e, i, value) => act(i, typeof value === 'string' ? value : undefined));
ipcMain.on('panel:cancel', () => { if (state.phase === 'working' && ctx) ctx.cancelled = true; else { sources = null; setState({ phase: 'idle' }); hidePanel(); } });
ipcMain.on('panel:hide', hidePanel);
ipcMain.on('panel:pile', (_e, yes) => setPile(yes));
ipcMain.on('panel:exif-step', (_e, d) => { const n = exifFiles.length; if (n) showExif((state.exif.index + d + n) % n); });
ipcMain.on('panel:exif-back', () => setState({ phase: sources ? 'proposal' : 'idle', exif: null }));
ipcMain.on('panel:exif-copy', () => state.exif?.info && clipboard.writeText(exifText(state.exif.info)));
ipcMain.on('panel:exif-map', () => { const g = state.exif?.info?.gps; if (g) shell.openExternal(`https://www.openstreetmap.org/?mlat=${g.lat}&mlon=${g.lon}#map=15/${g.lat}/${g.lon}`); });
ipcMain.on('panel:exif-all', async () => {
  const f = exifFiles[state.exif?.index]; if (!f) return;
  try { const all = await raw.allTags(await f.get()); setState({ exif: { ...state.exif, all } }); } catch {}
});
ipcMain.handle('gallery:info', async (_e, out) => {
  if (!allowed.has(out)) return null;
  const src = sourceOf.get(out); const file = src && fs.existsSync(src) ? src : out;
  try { return await raw.photoInfo(file); } catch { return null; }
});
ipcMain.on('gallery:map', (_e, g) => { if (g && Number.isFinite(g.lat) && Number.isFinite(g.lon)) shell.openExternal(`https://www.openstreetmap.org/?mlat=${g.lat}&mlon=${g.lon}#map=15/${g.lat}/${g.lon}`); });
ipcMain.on('panel:gallery', (_e, i) => openGallery(i == null ? state.result : state.recent[i]?.result));
ipcMain.on('panel:folder', () => { const r = state.result; if (r?.dirs[0]) shell.openPath(r.dirs[0]); else if (r?.outputs[0]) shell.showItemInFolder(r.outputs[0].path); });
ipcMain.on('panel:open', (_e, p) => allowed.has(p) && shell.openPath(p));
ipcMain.handle('email', async (_e, files, opts) => emailFiles(files.filter((f) => allowed.has(f)), opts));
ipcMain.handle('gallery:get', (e) => galleryResults.get(e.sender.id));
ipcMain.on('gallery:fullscreen', (e, on) => BrowserWindow.fromWebContents(e.sender)?.setFullScreen(!!on));
ipcMain.on('gallery:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.on('gallery:min', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('gallery:max', (e) => { const w = BrowserWindow.fromWebContents(e.sender); w.isMaximized() ? w.unmaximize() : w.maximize(); });
ipcMain.on('gallery:reveal', (_e, p) => allowed.has(p) && shell.showItemInFolder(p));
ipcMain.on('gallery:open', (_e, p) => allowed.has(p) && shell.openPath(p));
ipcMain.on('gallery:copy', (_e, p) => { if (allowed.has(p)) clipboard.writeImage(nativeImage.createFromPath(p)); });
ipcMain.on('gallery:pdf', async (_e, files) => {
  const fake = [{ type: 'file', path: files[0], items: files.filter((f) => allowed.has(f)).map((f) => ({ rel: path.basename(f), name: path.basename(f), ext: path.extname(f).toLowerCase(), kind: 'raster', abs: f, read: () => fs.promises.readFile(f) })) }];
  const r = await engine.run(fake, { id: 'pdf' }, { settings, progress: () => {} });
  if (r.outputs[0]) shell.showItemInFolder(r.outputs[0].path);
});

// ---------- tray & system integration ----------
function trayMenu() {
  const sendTo = process.platform === 'win32' ? path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo', 'Leaf.lnk') : null;
  return Menu.buildFromTemplate([
    { label: 'Show Leaf', click: () => { leafWin.show(); showPanel(); } },
    { label: 'Reset position', click: () => { settings.position = null; save(); const p = leafHome(); leafWin.setPosition(p.x, p.y); } },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings({ path: exePath }).openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked, path: exePath }) },
    ...(sendTo ? [{ label: 'Add to right-click “Send to”', type: 'checkbox', checked: fs.existsSync(sendTo), click: (i) => {
      if (i.checked) shell.writeShortcutLink(sendTo, { target: exePath, args: app.isPackaged ? '' : `"${app.getAppPath()}"`, description: 'Convert with Leaf', icon: exePath, iconIndex: 0 });
      else fs.rmSync(sendTo, { force: true });
    } }] : []),
    { label: 'Leaf Pile folder on desktop', type: 'checkbox', checked: settings.pile === true, click: (i) => setPile(i.checked) },
    { label: 'Glass: use Windows acrylic', type: 'checkbox', checked: settings.glass !== 'css', click: (i) => { settings.glass = i.checked ? 'auto' : 'css'; save(); app.relaunch(); app.exit(0); } },
    { type: 'separator' },
    { label: 'Quit Leaf', click: () => app.quit() },
  ]);
}

function argPaths(argv) { return argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && fs.existsSync(a) && path.resolve(a) !== app.getAppPath()); }

app.on('second-instance', (_e, argv) => { const p = argPaths(argv); if (p.length) handleDrop(p, { auto: argv.includes('--auto') }); else showPanel(); });

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('ca.vistek.leaf');
  for (const t of ['leaf-src', 'leaf-thumbs', 'leaf-email', 'leaf-render']) fs.rmSync(path.join(os.tmpdir(), t), { recursive: true, force: true }); // last session's temp files
  const APP_ROOT = path.join(__dirname, '..');
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css' };
  protocol.handle('leaf', async (req) => {
    const u = new URL(req.url);
    if (u.host === 'app') {
      // App files served cross-origin-isolated, so the darkroom's WebAssembly threads can share memory.
      const file = path.normalize(path.join(APP_ROOT, decodeURIComponent(u.pathname)));
      if (!file.startsWith(APP_ROOT + path.sep)) return new Response('', { status: 404 });
      const r = await net.fetch(pathToFileURL(file).toString()).catch(() => null);
      if (!r || !r.ok) return new Response('', { status: 404 });
      return new Response(r.body, { headers: { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' } });
    }
    const p = decodeURIComponent(u.pathname.slice(1));
    return allowed.has(p) ? net.fetch(pathToFileURL(p).toString()) : new Response('', { status: 404 });
  });
  createLeaf(); createPanel();
  // 32 px source declared as @2x: crisp at 100% and 200% scaling.
  tray = new Tray(nativeImage.createFromBuffer(fs.readFileSync(path.join(UI, 'tray.png')), { scaleFactor: 2 }));
  tray.setToolTip('Leaf — drop anything to convert');
  tray.setContextMenu(trayMenu());
  tray.on('click', () => { leafWin.show(); showPanel(); });
  nativeTheme.on('updated', broadcast);
  const p = argPaths(process.argv); if (p.length) leafWin.webContents.once('did-finish-load', () => handleDrop(p, { auto: process.argv.includes('--auto') }));
  if (settings.pile === true) makePile();
  if (!settings.welcomed) {
    settings.welcomed = true; save();
    setState({ pileOffer: settings.pile === undefined });
    if (!p.length) leafWin.webContents.once('did-finish-load', () => setTimeout(showPanel, 1200));
  }
  screen.on('display-metrics-changed', () => { const h = leafHome(); leafWin.setPosition(h.x, h.y); });
});
ipcMain.on('ready', broadcast);
app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => { engine.shutdown(); darkroom.close(); require('./engine/render').close(); raw.endExiftool(); });
