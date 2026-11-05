const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workroom', {
  onJob: (fn) => ipcRenderer.on('workroom:job', (_e, job) => fn(job)),
  done: (id, result) => ipcRenderer.send('workroom:done', { id, ...result }),
  ready: () => ipcRenderer.send('workroom:ready'),
});
