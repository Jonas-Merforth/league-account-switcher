const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit API surface exposed to the renderer. No Node access leaks through.
contextBridge.exposeInMainWorld('api', {
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  getStatus: () => ipcRenderer.invoke('accounts:status'),
  saveAccount: (data) => ipcRenderer.invoke('accounts:save', data),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  captureAccount: (id, force = false) => ipcRenderer.invoke('accounts:capture', { id, force }),
  getSignedInName: () => ipcRenderer.invoke('accounts:signed-in-name'),
  switchAccount: (id, force = false) => ipcRenderer.invoke('accounts:switch', { id, force }),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getAppearOffline: () => ipcRenderer.invoke('appearOffline:get'),
  setAppearOffline: (on) => ipcRenderer.invoke('appearOffline:set', on),
  getSettingsSync: () => ipcRenderer.invoke('settingsSync:get'),
  setSettingsSync: (on) => ipcRenderer.invoke('settingsSync:set', on),
  updateSettingsBaseline: () => ipcRenderer.invoke('settingsSync:updateBaseline'),
  applySettingsNow: () => ipcRenderer.invoke('settingsSync:applyNow'),
  dismissSettingsNotice: () => ipcRenderer.invoke('settingsSync:dismissNotice'),
  listRegions: () => ipcRenderer.invoke('regions:list'),
  getLayout: () => ipcRenderer.invoke('layout:get'),
  setLayout: (layout) => ipcRenderer.invoke('layout:set', layout),
  openHelp: () => ipcRenderer.invoke('help:open'),
  openPorofessor: () => ipcRenderer.invoke('porofessor:open'),
  openOpgg: () => ipcRenderer.invoke('opgg:open'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  refreshFriendsPoc: () => ipcRenderer.invoke('friends:poc-refresh'),

  // Auto-update
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getUpdateStatus: () => ipcRenderer.invoke('update:get'),

  // Push subscriptions. Each returns an unsubscribe function.
  onStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('status:update', handler);
    return () => ipcRenderer.removeListener('status:update', handler);
  },
  onAccountsChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('accounts:changed', handler);
    return () => ipcRenderer.removeListener('accounts:changed', handler);
  },
  onUpdateStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  },
  onAppearOffline: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('appearOffline:update', handler);
    return () => ipcRenderer.removeListener('appearOffline:update', handler);
  },
  onSettingsNotice: (callback) => {
    const handler = (_event, notice) => callback(notice);
    ipcRenderer.on('settingsSync:notice', handler);
    return () => ipcRenderer.removeListener('settingsSync:notice', handler);
  },
  onBaselineUpdated: (callback) => {
    const handler = (_event, meta) => callback(meta);
    ipcRenderer.on('settingsSync:baselineUpdated', handler);
    return () => ipcRenderer.removeListener('settingsSync:baselineUpdated', handler);
  }
});
