const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fixture', {
  report: result => ipcRenderer.send('fixture:submitted', result)
});
