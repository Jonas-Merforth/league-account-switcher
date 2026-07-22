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
  restartCurrentSwitch: () => ipcRenderer.invoke('accounts:restart-current-switch'),
  reloginAccount: (id) => ipcRenderer.invoke('accounts:switch', { id, force: false, forceLogin: true }),
  getStats: () => ipcRenderer.invoke('stats:get'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getNotificationSounds: () => ipcRenderer.invoke('notificationSounds:get'),
  saveNotificationSound: (kind, payload) => ipcRenderer.invoke('notificationSounds:save', kind, payload),
  resetNotificationSound: (kind) => ipcRenderer.invoke('notificationSounds:reset', kind),
  getChatState: () => ipcRenderer.invoke('chat:get'),
  openChat: (payload) => ipcRenderer.invoke('chat:open', payload),
  selectChat: (key) => ipcRenderer.invoke('chat:select', key),
  sendChatMessage: (key, body) => ipcRenderer.invoke('chat:send', { key, body }),
  setChatDraft: (key, draft) => ipcRenderer.invoke('chat:draft', { key, draft }),
  closeChat: (key) => ipcRenderer.invoke('chat:close', key),
  setChatViewActive: (active) => ipcRenderer.invoke('chat:view-active', active),
  getQueueRelayStatus: () => ipcRenderer.invoke('queueRelay:status'),
  setQueueRelayPermission: (puuid, allowed) => ipcRenderer.invoke('queueRelay:set-permission', { puuid, allowed }),
  startViaLeader: () => ipcRenderer.invoke('queueRelay:start-via-leader'),
  runClientCleanupOnce: () => ipcRenderer.invoke('clientCleanup:runOnce'),
  runClientCleanupDeepOnce: () => ipcRenderer.invoke('clientCleanup:runDeepOnce'),
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
  refreshFriendsPoc: (payload) => ipcRenderer.invoke('friends:poc-refresh', payload),
  validateFriendsPocSession: (accountId) => ipcRenderer.invoke('friends:poc-validate-session', { accountId }),
  repairFriendsSessions: (accountIds) => ipcRenderer.invoke('friends:repair-sessions', { accountIds }),
  getFriendsPocLobbyStatus: () => ipcRenderer.invoke('friends:poc-lobby-status'),
  getCurrentClientSummary: () => ipcRenderer.invoke('friends:current-client-summary'),
  inviteFriendToLobby: (friend) => ipcRenderer.invoke('friends:poc-invite', friend),
  joinFriendLobby: (lobby) => ipcRenderer.invoke('friends:poc-join-lobby', lobby),
  onFriendsPocProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('friends:poc-progress', handler);
    return () => ipcRenderer.removeListener('friends:poc-progress', handler);
  },
  onFriendsRepairProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('friends:repair-progress', handler);
    return () => ipcRenderer.removeListener('friends:repair-progress', handler);
  },
  onFriendsPocRanks: (callback) => {
    const handler = (_event, update) => callback(update);
    ipcRenderer.on('friends:poc-ranks', handler);
    return () => ipcRenderer.removeListener('friends:poc-ranks', handler);
  },

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
  onStatsChanged: (callback) => {
    const handler = (_event, stats) => callback(stats);
    ipcRenderer.on('stats:changed', handler);
    return () => ipcRenderer.removeListener('stats:changed', handler);
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
  onAutoAccepted: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('autoAccept:accepted', handler);
    return () => ipcRenderer.removeListener('autoAccept:accepted', handler);
  },
  onQueueDodged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('queue:dodged', handler);
    return () => ipcRenderer.removeListener('queue:dodged', handler);
  },
  onSettingsNotice: (callback) => {
    const handler = (_event, notice) => callback(notice);
    ipcRenderer.on('settingsSync:notice', handler);
    return () => ipcRenderer.removeListener('settingsSync:notice', handler);
  },
  onQueueRelay: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('queueRelay:update', handler);
    return () => ipcRenderer.removeListener('queueRelay:update', handler);
  },
  onChatUpdate: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('chat:update', handler);
    return () => ipcRenderer.removeListener('chat:update', handler);
  },
  onBaselineUpdated: (callback) => {
    const handler = (_event, meta) => callback(meta);
    ipcRenderer.on('settingsSync:baselineUpdated', handler);
    return () => ipcRenderer.removeListener('settingsSync:baselineUpdated', handler);
  }
});
