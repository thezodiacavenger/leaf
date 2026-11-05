const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('darkroom', {
  onJob: (fn) => ipcRenderer.on('darkroom:job', (_e, job) => fn(job)),
  done: (id, result) => ipcRenderer.send('darkroom:done', { id, ...result }),
  ready: () => ipcRenderer.send('darkroom:ready'),
});
