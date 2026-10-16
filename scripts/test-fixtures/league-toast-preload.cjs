const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('fixture',{report:state=>ipcRenderer.send('fixture:state',state)});
