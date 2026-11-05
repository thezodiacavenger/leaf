const { contextBridge, ipcRenderer, webUtils } = require('electron');

const ok = (ch) => /^(leaf|panel|gallery):|^(ready|email)$/.test(ch);
contextBridge.exposeInMainWorld('leaf', {
  send: (ch, ...a) => ok(ch) && ipcRenderer.send(ch, ...a),
  invoke: (ch, ...a) => (ok(ch) ? ipcRenderer.invoke(ch, ...a) : Promise.reject(new Error('blocked'))),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, ...a) => fn(...a)),
  pathsOf: (files) => Array.from(files || []).map((f) => webUtils.getPathForFile(f)).filter(Boolean),
  url: (p) => 'leaf://f/' + encodeURIComponent(p),
});
