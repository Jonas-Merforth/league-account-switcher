import { nextUpdateView } from './updateState.js';
import { rankViews, smartFriendRankView } from './rankView.js';
import { accountSubtitle } from './accountDisplay.js';
import { friendJoinKey, friendJoinPayload, friendJoinView, isCurrentFriend, shouldConfirmLobbyJoin } from './friendLobbyActions.js';
import { retryLoginTypingView } from '../core/switchRetry.js';
import { friendFavoriteKey, isFavoriteFriend, sortFriendsForFavorites } from './friendFavorites.js';
import { friendCardSourceSummary, friendFailureActionLabel, friendSourceSummary, friendSourceOrder, playingWithBadgeLabel } from './friendSourceView.js';
import { progressLaneView, updateProgressRows } from './friendProgressView.js';
import { friendPresenceTone } from './friendPresenceTone.js';
import {
  friendActivityTooltip,
  friendLobbyOccupancy,
  friendStateText,
  isMobileFriend,
  playingWithFriends
} from './friendStatusView.js';
import { friendsAutoRefreshDelay, shouldRefreshFriendsOnTabClick } from './friendRefreshBehavior.js';
import { queueRelayButtonView } from './queueRelayView.js';
import { friendSpectatorStatsView } from './spectatorStatsView.js';
import {
  chatConnectionView,
  chatDestinationLabel,
  chatFriendPresenceView,
  chatPreview,
  chatRoute,
  chatSourceLabel,
  chatSourceOptions
} from './chatView.js';

const api = window.api;
const $ = (id) => document.getElementById(id);

const state = {
  accounts: [],
  regions: [],
  settings: {
    defaultRegion: 'euw',
    startWithWindows: true,
    autoUpdate: true,
    autoAccept: false,
    autoAcceptDelayMs: 2000,
    autoAcceptSound: false,
    autoAcceptSoundVolume: 70,
    autoClientCleanup: false,
    friendsPocAggressiveFetching: false,
    friendsSpectatorStats: false,
    friendsPocUseAllAccounts: false,
    friendsPocSelectedAccountIds: [],
    friendsPocSelectionInitialized: false,
    friendsPocFavoriteFriendKeys: [],
    friendsPocAutoRefresh: false,
    friendsPocAutoRefreshMs: 60_000,
    chatOnlineLeaseMs: 180_000,
    queueRelayAllowedPuuids: []
  },
  status: { busy: false, stage: 'idle', message: 'Idle' },
  stats: { accounts: [] },
  editingId: null,
  updateStatus: { state: 'idle' },
  updateDismissed: false,
  appearOffline: false,
  settingsSync: { on: false, hasBaseline: false, capturedAt: null, account: null },
  settingsNotice: null,
  friendsPoc: {
    loading: false,
    data: null,
    error: null,
    showOffline: false,
    showMobile: false,
    progress: null,
    progressRows: [],
    progressExpanded: false,
    repairing: false,
    repairProgress: null,
    sourcesExpanded: false,
    lastRefreshAt: null,
    lastAutoRefreshAt: null
  },
  friendsPocLobby: { inLobby: false, canInvite: false, phase: null, partyId: '', localPuuid: '', memberPuuids: [] },
  spectatorStats: { enabled: false, service: {}, unavailableFriends: [], games: [] },
  currentClient: null,
  friendInviteState: {},
  friendJoinState: {},
  friendsCurrentCollapsed: false,
  queueRelay: { connected: false, connectionState: 'starting', reason: 'Queue relay is starting.', lobby: {}, leader: {}, peers: [] },
  chat: { activeKey: '', unreadCount: 0, conversations: [] },
  chatPickerFriend: null,
  activeTab: 'accounts',
  layout: { top: [], sections: [] }
};

let updateTransientTimer = null;
let statusDismissTimer = null;
let clientCleanupHintTimer = null;
let friendsAutoRefreshTimer = null;
let friendsLocalContextRefreshing = false;
let chatDraftTimer = null;
let dragKind = null; // 'card' | 'section'
let dragId = null;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function init() {
  const storedTab = localStorage.getItem('activeTab');
  state.activeTab = ['accounts', 'friends', 'chat'].includes(storedTab) ? storedTab : 'accounts';
  state.friendsCurrentCollapsed = localStorage.getItem('friendsCurrentAccountCollapsed') === '1';
  state.regions = await api.listRegions();
  state.settings = await api.getSettings();
  state.status = await api.getStatus();
  state.queueRelay = await api.getQueueRelayStatus();
  state.chat = await api.getChatState();
  state.spectatorStats = await api.getSpectatorStats();

  populateRegionSelect($('defaultRegion'));
  populateRegionSelect($('fRegion'));
  $('defaultRegion').value = state.settings.defaultRegion;
  $('startWithWindows').checked = !!state.settings.startWithWindows;
  $('autoUpdate').checked = !!state.settings.autoUpdate;
  $('autoAcceptDelay').value = Math.round((state.settings.autoAcceptDelayMs ?? 2000) / 1000);
  renderAutoAcceptSoundSetting();
  renderClientCleanupSetting();
  $('friendsPocAggressiveFetching').checked = !!state.settings.friendsPocAggressiveFetching;
  $('friendsSpectatorStats').checked = !!state.settings.friendsSpectatorStats;
  $('chatOnlineLeaseSeconds').value = Math.round((state.settings.chatOnlineLeaseMs ?? 180_000) / 1_000);
  syncFriendsAutoRefreshControls();
  state.appearOffline = !!(await api.getAppearOffline()).on;
  renderClientToggles();

  const sync = await api.getSettingsSync();
  applySettingsSyncState(sync);
  renderSettingsNotice(sync.notice);

  await reloadAccounts();
  await ensureInitialFriendsSelection();
  await refreshFriendsLocalContext();
  renderStatus();
  renderFriendsPoc();
  renderChat();
  setActiveTab(state.activeTab);
  wireEvents();
  if (state.activeTab === 'friends') refreshFriendsPocFromTabClick();
  scheduleFriendsAutoRefresh();
  setSettingsPanel(localStorage.getItem('settingsPanelOpen') === '1');
  setInterval(() => {
    if (state.friendsPoc.data) renderFriendsPoc();
  }, 30_000);
  setInterval(() => {
    if (state.activeTab === 'chat') renderChatConnection();
  }, 1_000);
  setInterval(refreshOpenSpectatorStatsTips, 1_000);
  setInterval(refreshFriendsLocalContext, 3_000);

  api.onAppearOffline((s) => {
    state.appearOffline = !!(s && s.on);
    renderClientToggles();
  });
  api.onAutoAccepted(() => playAutoAcceptSound());
  api.onQueueDodged(() => playQueueDodgeSound());
  api.onSettingsNotice((notice) => renderSettingsNotice(notice));
  api.onFriendsPocProgress((progress) => handleFriendsPocProgress(progress));
  api.onFriendsRepairProgress((progress) => {
    if (!state.friendsPoc.repairing) return;
    state.friendsPoc.repairProgress = progress;
    renderFriendsPoc();
  });
  api.onFriendsPocRanks((update) => handleFriendsPocRanks(update));
  api.onSpectatorStats((snapshot) => {
    state.spectatorStats = snapshot || { enabled: false, service: {}, unavailableFriends: [], games: [] };
    refreshOpenSpectatorStatsTips();
    renderFriendsPoc();
  });
  api.onQueueRelay((status) => {
    state.queueRelay = status || state.queueRelay;
    renderQueueRelay();
  });
  api.onChatUpdate((chat) => {
    state.chat = chat || { activeKey: '', unreadCount: 0, conversations: [] };
    renderChat();
  });
  api.onBaselineUpdated((meta) => {
    applySettingsSyncState({ on: true, hasBaseline: true, capturedAt: meta.capturedAt, account: meta.account });
  });

  api.onStatus((status) => {
    const wasBusy = state.status.busy;
    state.status = status;
    closeFriendSourceSwitchMenu();
    renderStatus();
    if (wasBusy && !status.busy) {
      reloadAccounts();
      refreshFriendsLocalContext();
    }
    renderAccounts(); // refresh disabled states
    renderFriendsPoc();
  });
  api.onAccountsChanged(() => reloadAccounts());
  api.onStatsChanged((stats) => {
    state.stats = stats || { accounts: [] };
    renderFriendsPoc();
    if (!$('statsOverlay').classList.contains('hidden')) renderStatsModal();
  });

  api.onUpdateStatus((status) => {
    state.updateStatus = status || { state: 'idle' };
    renderUpdateBanner();
  });
  state.updateStatus = (await api.getUpdateStatus()) || { state: 'idle' };
  renderUpdateBanner();
}

async function reloadAccounts() {
  const [accounts, layout, stats] = await Promise.all([
    api.listAccounts(),
    api.getLayout(),
    api.getStats()
  ]);
  state.accounts = accounts;
  state.layout = layout;
  state.stats = stats || { accounts: [] };
  renderAccounts();
  renderFriendsPoc();
}

function currentClientIdentity(client) {
  return String(client?.livePuuid || client?.liveRiotId || client?.accountId || '').trim().toLowerCase();
}

async function refreshFriendsLocalContext() {
  if (friendsLocalContextRefreshing) return;
  friendsLocalContextRefreshing = true;
  const previousIdentity = currentClientIdentity(state.currentClient);
  try {
    const [lobbyResult, clientResult, relayResult] = await Promise.allSettled([
      api.getFriendsPocLobbyStatus(),
      api.getCurrentClientSummary(),
      api.getQueueRelayStatus()
    ]);
    const nextLobby = lobbyResult.status === 'fulfilled' ? lobbyResult.value : null;
    state.friendsPocLobby = {
      inLobby: !!nextLobby?.inLobby,
      canInvite: nextLobby?.canInvite !== false,
      phase: nextLobby?.phase || null,
      partyId: nextLobby?.partyId || '',
      localPuuid: nextLobby?.localPuuid || '',
      memberPuuids: Array.isArray(nextLobby?.memberPuuids) ? nextLobby.memberPuuids : [],
      memberCount: Number(nextLobby?.memberCount || 0),
      partyType: nextLobby?.partyType || '',
      reason: nextLobby?.reason || (lobbyResult.status === 'rejected' ? friendly(lobbyResult.reason) : '')
    };
    state.currentClient = clientResult.status === 'fulfilled'
      ? clientResult.value
      : {
          kind: 'unavailable', statusLabel: 'Status unavailable',
          detail: friendly(clientResult.reason), tone: 'offline', accountId: null, livePuuid: ''
        };
    if (relayResult.status === 'fulfilled') state.queueRelay = relayResult.value;

    const nextIdentity = currentClientIdentity(state.currentClient);
    if (previousIdentity && previousIdentity !== nextIdentity) {
      state.friendInviteState = {};
      state.friendJoinState = {};
    }
  } finally {
    friendsLocalContextRefreshing = false;
  }
  renderFriendsPoc();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function populateRegionSelect(select) {
  select.innerHTML = '';
  for (const region of state.regions) {
    const opt = document.createElement('option');
    opt.value = region.code;
    opt.textContent = region.label;
    select.appendChild(opt);
  }
}

function renderAccounts() {
  const list = $('accountList');
  list.innerHTML = '';
  $('emptyState').classList.toggle('hidden', state.accounts.length > 0);

  const byId = new Map(state.accounts.map((a) => [a.id, a]));
  const busy = state.status.busy;

  // Unordered (top) group — always present as a drop target.
  const top = renderGroup({ kind: 'top' }, state.layout.top, byId, busy);
  top.classList.add('top-zone');
  list.appendChild(top);

  // Named sections.
  for (const section of state.layout.sections) {
    list.appendChild(renderSection(section, byId, busy));
  }

  // Add-section button, under the last account / section.
  list.appendChild(btn('+ Add section', 'btn small add-section', false, addSection));

  wireSectionReorder(list);
}

function renderGroup(target, ids, byId, busy) {
  const zone = document.createElement('div');
  zone.className = 'drop-zone';
  zone.dataset.dropKind = target.kind;
  if (target.id) zone.dataset.dropId = target.id;
  for (const id of ids) {
    const account = byId.get(id);
    if (account) zone.appendChild(renderCard(account, busy));
  }
  wireCardDropZone(zone, target);
  return zone;
}

function renderSection(section, byId, busy) {
  const wrap = document.createElement('div');
  wrap.className = 'section' + (section.collapsed ? ' collapsed' : '');
  wrap.dataset.sectionId = section.id;

  const header = document.createElement('div');
  header.className = 'section-header';
  header.draggable = true;
  header.appendChild(el('span', 'chevron', section.collapsed ? '▸' : '▾'));
  header.appendChild(el('span', 'section-name', section.name));
  header.appendChild(el('span', 'section-count', String(section.accountIds.length)));
  header.appendChild(el('span', 'section-spacer'));
  header.appendChild(iconBtn('✎', 'Rename section', () => renameSection(section)));
  header.appendChild(iconBtn('🗑', 'Delete section', () => deleteSection(section)));
  header.addEventListener('click', (e) => {
    if (e.target.closest('.section-icon-btn')) return;
    toggleSection(section.id);
  });
  wireSectionHeaderDrag(header, section.id);
  wrap.appendChild(header);

  const body = renderGroup({ kind: 'section', id: section.id }, section.accountIds, byId, busy);
  body.classList.add('section-body');
  if (section.collapsed) body.classList.add('hidden');
  wrap.appendChild(body);
  return wrap;
}

// ---------------------------------------------------------------------------
// Drag & drop (vanilla)
// ---------------------------------------------------------------------------
function wireCardDrag(card, id) {
  card.addEventListener('dragstart', (e) => {
    if (e.target.closest('.card-actions')) { e.preventDefault(); return; } // not from the buttons
    dragKind = 'card';
    dragId = id;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', id); } catch { /* ignore */ }
    card.classList.add('dragging');
    document.body.classList.add('dragging-card'); // stabilises empty drop zones (see styles.css)
  });
  card.addEventListener('dragend', endDrag);
}

function wireCardDropZone(zone, target) {
  zone.addEventListener('dragover', (e) => {
    if (dragKind !== 'card') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    zone.classList.add('drag-over');
    showInsertion(zone, computeBeforeId(zone, e.clientY));
  });
  zone.addEventListener('dragleave', (e) => {
    if (!zone.contains(e.relatedTarget)) { zone.classList.remove('drag-over'); clearInsertion(); }
  });
  zone.addEventListener('drop', (e) => {
    if (dragKind !== 'card') return;
    e.preventDefault();
    e.stopPropagation();
    const beforeId = computeBeforeId(zone, e.clientY);
    zone.classList.remove('drag-over');
    clearInsertion();
    moveAccount(dragId, target, beforeId);
  });
}

function computeBeforeId(zone, y) {
  const cards = [...zone.querySelectorAll(':scope > .account-card')].filter((c) => c.dataset.id !== dragId);
  for (const card of cards) {
    const r = card.getBoundingClientRect();
    if (y < r.top + r.height / 2) return card.dataset.id;
  }
  return null;
}

function showInsertion(zone, beforeId) {
  clearInsertion();
  const line = document.createElement('div');
  line.className = 'drop-line';
  const before = beforeId ? zone.querySelector(`:scope > .account-card[data-id="${beforeId}"]`) : null;
  if (before) zone.insertBefore(line, before);
  else zone.appendChild(line);
}
function clearInsertion() {
  document.querySelectorAll('.drop-line').forEach((n) => n.remove());
}
function endDrag() {
  document.body.classList.remove('dragging-card');
  document.querySelectorAll('.account-card.dragging').forEach((c) => c.classList.remove('dragging'));
  document.querySelectorAll('.drag-over').forEach((z) => z.classList.remove('drag-over'));
  clearInsertion();
  dragKind = null;
  dragId = null;
}

// Section reorder: drag the header; the list decides insertion among section wrappers.
function wireSectionHeaderDrag(header, sectionId) {
  header.addEventListener('dragstart', (e) => {
    if (e.target.closest('.section-icon-btn')) { e.preventDefault(); return; }
    e.stopPropagation();
    dragKind = 'section';
    dragId = sectionId;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', sectionId); } catch { /* ignore */ }
  });
  header.addEventListener('dragend', endDrag);
}
function wireSectionReorder(list) {
  list.addEventListener('dragover', (e) => {
    if (dragKind !== 'section') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  list.addEventListener('drop', (e) => {
    if (dragKind !== 'section') return;
    e.preventDefault();
    moveSection(dragId, computeBeforeSectionId(list, e.clientY));
  });
}
function computeBeforeSectionId(list, y) {
  const secs = [...list.querySelectorAll(':scope > .section')].filter((s) => s.dataset.sectionId !== dragId);
  for (const sec of secs) {
    const r = sec.getBoundingClientRect();
    if (y < r.top + r.height / 2) return sec.dataset.sectionId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layout mutation (optimistic, persisted via IPC)
// ---------------------------------------------------------------------------
function cloneLayout() {
  return {
    top: [...state.layout.top],
    sections: state.layout.sections.map((s) => ({ ...s, accountIds: [...s.accountIds] }))
  };
}
function removeIdEverywhere(layout, id) {
  layout.top = layout.top.filter((x) => x !== id);
  for (const s of layout.sections) s.accountIds = s.accountIds.filter((x) => x !== id);
}
function moveAccount(id, target, beforeId) {
  if (!id) return;
  const layout = cloneLayout();
  removeIdEverywhere(layout, id);
  const listRef = target.kind === 'top'
    ? layout.top
    : layout.sections.find((s) => s.id === target.id)?.accountIds;
  if (!listRef) return;
  const idx = beforeId ? listRef.indexOf(beforeId) : -1;
  if (idx >= 0) listRef.splice(idx, 0, id);
  else listRef.push(id);
  applyLayout(layout);
}
function moveSection(id, beforeId) {
  if (!id || id === beforeId) return;
  const layout = cloneLayout();
  const idx = layout.sections.findIndex((s) => s.id === id);
  if (idx < 0) return;
  const [sec] = layout.sections.splice(idx, 1);
  const before = beforeId ? layout.sections.findIndex((s) => s.id === beforeId) : -1;
  if (before >= 0) layout.sections.splice(before, 0, sec);
  else layout.sections.push(sec);
  applyLayout(layout);
}
function toggleSection(id) {
  const layout = cloneLayout();
  const s = layout.sections.find((x) => x.id === id);
  if (s) { s.collapsed = !s.collapsed; applyLayout(layout); }
}
async function addSection() {
  const name = await promptName('New section', '');
  if (!name) return;
  const layout = cloneLayout();
  layout.sections.push({ id: genSectionId(), name, collapsed: false, accountIds: [] });
  applyLayout(layout);
}
async function renameSection(section) {
  const name = await promptName('Rename section', section.name);
  if (!name) return;
  const layout = cloneLayout();
  const s = layout.sections.find((x) => x.id === section.id);
  if (s) { s.name = name; applyLayout(layout); }
}
async function deleteSection(section) {
  const ok = await confirmDialog('Delete section',
    `Delete the section <b>${escapeHtml(section.name)}</b>? Its accounts move back to Unordered (they're not deleted).`,
    'Delete');
  if (!ok) return;
  const layout = cloneLayout();
  const s = layout.sections.find((x) => x.id === section.id);
  if (!s) return;
  layout.top.push(...s.accountIds);
  layout.sections = layout.sections.filter((x) => x.id !== section.id);
  applyLayout(layout);
}
async function applyLayout(layout) {
  state.layout = layout;
  renderAccounts();
  try {
    state.layout = await api.setLayout(layout);
  } catch {
    // Keep the optimistic state; the next reload reconciles.
  }
}
function genSectionId() {
  try { return crypto.randomUUID(); }
  catch { return `sec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
}

function renderCard(account, busy) {
  const card = document.createElement('div');
  card.className = 'account-card' + (account.isCurrent ? ' is-current' : '');
  card.draggable = true;
  card.dataset.id = account.id;
  wireCardDrag(card, account.id);

  // Horizontal split: the account info/buttons on the left, the two rank crests on the right.
  const main = el('div', 'card-main');
  card.appendChild(main);

  const top = document.createElement('div');
  top.className = 'card-top';
  top.appendChild(el('span', 'card-name', account.label));
  if (account.region) top.appendChild(el('span', 'badge region', regionShort(account.region)));
  if (account.isCurrent) top.appendChild(el('span', 'badge active', 'Active'));
  main.appendChild(top);

  const subtitle = accountSubtitle(account);
  if (subtitle) main.appendChild(el('div', 'card-sub', subtitle));

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const age = account.sessionAge || {};
  if (!account.hasSession) {
    meta.appendChild(el('span', 'tag dim', account.hasPassword
      ? 'No saved session — will sign in with password'
      : 'No saved session — capture or add a password'));
  } else if (age.stale) {
    meta.appendChild(el('span', 'tag warn', `${age.text} — may be expired, re-capture`));
  } else {
    meta.appendChild(el('span', 'tag', age.text || 'Session saved'));
  }
  main.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  actions.appendChild(btn('Switch', 'btn primary small', busy, () => doSwitch(account.id)));
  actions.appendChild(btn('Capture', 'btn small', busy, () => doCapture(account)));
  actions.appendChild(btn('Edit', 'btn small ghost', busy, () => openForm(account)));
  actions.appendChild(btn('Delete', 'btn small danger', busy, () => doDelete(account)));
  main.appendChild(actions);

  card.appendChild(renderRanks(account));

  return card;
}

// The two rank crests (Solo/Duo, Flex) with division overlay and hover tooltip.
function renderRanks(account) {
  const wrap = el('div', 'card-ranks');
  for (const view of rankViews(account.ranks ?? null)) {
    const emblem = el('div', `rank-emblem ${view.state}`);
    const img = document.createElement('img');
    img.src = view.img;
    img.alt = view.label;
    img.draggable = false; // don't hijack the card's drag-and-drop
    emblem.appendChild(img);
    if (view.overlay) emblem.appendChild(el('span', 'rank-div', view.overlay));
    const tip = el('div', 'rank-tip');
    tip.appendChild(el('div', 'tip-queue', view.tip[0]));
    for (const line of view.tip.slice(1)) tip.appendChild(el('div', 'tip-line', line));
    emblem.appendChild(tip);
    wrap.appendChild(emblem);
  }
  return wrap;
}

function renderStatus() {
  const panel = $('statusPanel');
  const status = state.status;
  if (statusDismissTimer) { clearTimeout(statusDismissTimer); statusDismissTimer = null; }
  const showable = status.busy || status.stage === 'error' || status.stage === 'done';
  panel.classList.toggle('hidden', !showable);
  panel.classList.toggle('is-error', status.stage === 'error');
  panel.classList.toggle('is-done', status.stage === 'done');
  $('statusMessage').textContent = status.message || '';

  const actions = $('statusActions');
  actions.innerHTML = '';
  const retry = retryLoginTypingView(status);
  if (retry.visible) {
    const retryButton = btn(retry.label, 'btn primary small', false, retryCurrentSwitch);
    retryButton.title = retry.title;
    actions.appendChild(retryButton);
  }
  if (status.stage === 'error' && /force the switch/i.test(status.message || '') && status.id) {
    actions.appendChild(btn('Force switch (closes the game)', 'btn danger small', false,
      () => doSwitch(status.id, true)));
  }
  if (status.stage === 'error' || status.stage === 'done') {
    actions.appendChild(noticeCloseBtn(() => panel.classList.add('hidden')));
  }

  // Success messages clear themselves; errors stay until dismissed.
  if (status.stage === 'done' && !status.busy) {
    statusDismissTimer = setTimeout(() => {
      panel.classList.add('hidden');
      statusDismissTimer = null;
    }, 6000);
  }
}

function savedFriendSourceAccounts() {
  return state.accounts.filter((account) => account.hasSession);
}

function selectedFriendSourceIds() {
  const saved = savedFriendSourceAccounts();
  if (state.settings.friendsPocUseAllAccounts) return saved.map((account) => account.id);
  const selected = new Set(state.settings.friendsPocSelectedAccountIds || []);
  return saved.filter((account) => selected.has(account.id)).map((account) => account.id);
}

function selectedFriendSourceAccounts() {
  const selected = new Set(selectedFriendSourceIds());
  return savedFriendSourceAccounts().filter((account) => selected.has(account.id));
}

function friendActionLobbyStatus() {
  return {
    ...state.friendsPocLobby,
    busy: !!state.status.busy,
    phase: state.friendsPocLobby.phase || state.currentClient?.phase,
    reason: state.friendsPocLobby.reason || (state.currentClient?.kind === 'closed'
      ? 'League is not running. Start and sign in to League first.'
      : '')
  };
}

function friendInviteKey(friend) {
  return String(friend?.puuid || friend?.riotId || friend?.gameName || '').trim();
}

function friendIsInCurrentLobby(friend) {
  const puuid = String(friend?.puuid || '').toLowerCase();
  if (!puuid) return false;
  return (state.friendsPocLobby.memberPuuids || []).some((memberPuuid) =>
    String(memberPuuid || '').toLowerCase() === puuid);
}

function friendIsCurrentAccount(friend) {
  const source = (state.friendsPoc.data?.accounts || []).find((account) =>
    account.accountId && account.accountId === state.currentClient?.accountId);
  const currentClient = source?.selfPuuid && !state.currentClient?.livePuuid
    ? { ...state.currentClient, livePuuid: source.selfPuuid }
    : state.currentClient;
  return isCurrentFriend(friend, state.friendsPocLobby, currentClient);
}

function canShowFriendInvite(friend) {
  const local = friendActionLobbyStatus();
  if (local.busy || local.phase !== 'Lobby' || !local.inLobby || !local.canInvite) return false;
  if (!friend?.online || isMobileFriend(friend)) return false;
  if (!friendInviteKey(friend)) return false;
  if (friendIsCurrentAccount(friend) || friendIsInCurrentLobby(friend)) return false;
  return true;
}

async function ensureInitialFriendsSelection() {
  if (state.settings.friendsPocSelectionInitialized) return;
  if (state.settings.friendsPocUseAllAccounts || (state.settings.friendsPocSelectedAccountIds || []).length) {
    state.settings = await api.setSettings({ friendsPocSelectionInitialized: true });
    return;
  }
  const preferred = ['umisteba', 'dr bonk'];
  const saved = savedFriendSourceAccounts();
  const ids = preferred
    .map((label) => saved.find((account) => account.label.toLowerCase() === label)?.id)
    .filter(Boolean);
  if (!ids.length) return;
  state.settings = await api.setSettings({
    friendsPocSelectedAccountIds: ids,
    friendsPocSelectionInitialized: true
  });
}

function renderFriendsPocSources() {
  const saved = savedFriendSourceAccounts();
  const selectedIds = selectedFriendSourceIds();
  const selectedSet = new Set(selectedIds);
  const useAll = !!state.settings.friendsPocUseAllAccounts;
  const button = $('friendsPocAccountsBtn');
  const selectAll = $('friendsPocSelectAll');
  const choices = $('friendsPocAccountChoices');

  button.textContent = useAll
    ? `Sources: all ${saved.length}`
    : selectedIds.length
      ? `Sources: ${selectedIds.length}`
      : 'Select sources';
  selectAll.checked = useAll;
  selectAll.disabled = !saved.length;
  choices.innerHTML = '';

  if (!saved.length) {
    choices.appendChild(el('div', 'friends-account-empty', 'No saved sessions available.'));
  }

  for (const account of saved) {
    const label = el('label', 'friends-account-option');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = useAll || selectedSet.has(account.id);
    checkbox.disabled = useAll;
    checkbox.addEventListener('change', () => updateFriendSourceSelection(account.id, checkbox.checked));
    label.appendChild(checkbox);
    const text = el('span', 'friends-account-label');
    text.appendChild(el('span', 'friends-account-name', account.label));
    text.appendChild(el('span', 'friends-account-sub', account.lastSummonerName || account.username || account.region || 'Saved session'));
    label.appendChild(text);
    choices.appendChild(label);
  }

  const refresh = $('friendsPocRefresh');
  refresh.disabled = state.friendsPoc.loading || selectedIds.length === 0;
  refresh.title = state.friendsPoc.loading
    ? 'A Friends refresh is already running.'
    : selectedIds.length === 0
      ? 'Select at least one saved-session source before refreshing.'
      : 'Refresh the merged friend list.';
}

function renderFriendsTabBadge() {
  const badge = $('friendsTabBadge');
  const data = state.friendsPoc.data;
  badge.classList.toggle('hidden', !data);
  if (data) {
    // The badge counts who you'd actually see: online friends, minus mobile-only ones (hidden by default).
    const friends = data.merged.filter((friend) => !friendIsCurrentAccount(friend));
    const mobileOnline = state.friendsPoc.showMobile
      ? 0
      : friends.filter((friend) => friend.online && isMobileFriend(friend)).length;
    badge.textContent = String(Math.max(0, friends.filter((friend) => friend.online).length - mobileOnline));
  }
}

function renderFriendsPocMeta() {
  const data = state.friendsPoc.data;
  const selectedCount = selectedFriendSourceIds().length;
  const savedCount = savedFriendSourceAccounts().length;
  const mode = state.settings.friendsPocAggressiveFetching ? 'Aggressive parallel' : 'Careful sequential';
  const last = data && data.refreshedAt ? `${relativeAge(data.refreshedAt)} (${formatTime(data.refreshedAt)})` : 'never';
  const refreshMode = state.settings.friendsPocAutoRefresh
    ? `Auto ${Math.round(friendsAutoRefreshMs() / 1000)}s`
    : 'On click';
  const compactMode = state.settings.friendsPocAggressiveFetching ? 'Aggressive' : 'Careful';
  const parts = [refreshMode, compactMode, `${selectedCount}/${savedCount} sources`, data ? `Updated ${relativeAge(data.refreshedAt)}` : 'Not fetched'];
  if (data && Number.isFinite(data.elapsedMs)) parts.push(formatDuration(data.elapsedMs));
  const meta = $('friendsPocMeta');
  meta.textContent = parts.join(' · ');
  meta.title = [
    state.settings.friendsPocAutoRefresh ? `Auto refresh every ${Math.round(friendsAutoRefreshMs() / 1000)} seconds` : 'Refresh when the Friends tab is clicked',
    mode,
    `${selectedCount}/${savedCount} saved-session sources`,
    `Last fetch: ${last}`,
    data && Number.isFinite(data.elapsedMs) ? `Fetch took ${formatDuration(data.elapsedMs)}` : ''
  ].filter(Boolean).join(' · ');
}

function currentClientView() {
  const live = state.currentClient || {
    kind: 'loading', statusLabel: 'Checking client status',
    detail: 'Looking for Riot Client and League…', tone: 'pending', accountId: null
  };
  if (!state.status.busy) return live;
  return {
    ...live,
    kind: 'switching',
    accountId: state.status.id || live.accountId,
    liveName: state.status.label || live.liveName,
    statusLabel: 'Switching account',
    detail: state.status.message || 'Preparing Riot Client…',
    tone: 'pending'
  };
}

function renderCurrentClientSummary() {
  const wrap = $('friendsCurrentAccount');
  if (!wrap) return;
  const view = currentClientView();
  const account = state.accounts.find((item) => item.id === view.accountId) || null;
  const hasLiveAccount = !['closed', 'signed-out', 'riot-idle', 'loading', 'unavailable'].includes(view.kind);
  const displayName = account?.label || view.liveRiotId || view.liveName ||
    (view.kind === 'signed-out' ? 'No account signed in' : 'No account open');
  const subtitle = account ? accountSubtitle(account) : (view.liveRiotId && view.liveRiotId !== displayName ? view.liveRiotId : '');

  wrap.className = `friends-current-account tone-${view.tone || 'offline'} kind-${view.kind || 'unknown'}${state.friendsCurrentCollapsed ? ' collapsed' : ''}`;
  wrap.innerHTML = '';

  const avatar = el('div', 'friends-current-avatar', hasLiveAccount
    ? String(displayName).trim().charAt(0).toUpperCase() || '•'
    : '—');
  avatar.setAttribute('aria-hidden', 'true');
  wrap.appendChild(avatar);

  const body = el('div', 'friends-current-body');
  const eyebrow = el('div', 'friends-current-eyebrow', hasLiveAccount ? 'Current account' : 'Client status');
  body.appendChild(eyebrow);
  const title = el('div', 'friends-current-title');
  title.appendChild(el('span', 'friends-current-name', displayName));
  const status = el('span', `friends-current-status tone-${view.tone || 'offline'}`);
  status.appendChild(el('span', 'friends-current-status-dot'));
  status.appendChild(el('span', '', view.statusLabel || 'Unknown'));
  title.appendChild(status);
  body.appendChild(title);
  if (subtitle) body.appendChild(el('div', 'friends-current-subtitle', subtitle));
  body.appendChild(el('div', 'friends-current-detail', view.detail || ''));
  wrap.appendChild(body);

  const rankSlot = el('div', 'friends-current-rank-slot');
  if (hasLiveAccount) {
    const ranks = renderRanks(account || { ranks: null });
    ranks.classList.add('friends-current-ranks');
    rankSlot.appendChild(ranks);
  }
  wrap.appendChild(rankSlot);

  const toggleDirection = state.friendsCurrentCollapsed ? 'is-expand' : 'is-collapse';
  const toggle = btn('', `friends-current-toggle ${toggleDirection}`, false, (event) => {
    event.stopPropagation();
    state.friendsCurrentCollapsed = !state.friendsCurrentCollapsed;
    localStorage.setItem('friendsCurrentAccountCollapsed', state.friendsCurrentCollapsed ? '1' : '0');
    renderCurrentClientSummary();
  });
  toggle.title = state.friendsCurrentCollapsed ? 'Expand current account details' : 'Collapse current account details';
  toggle.setAttribute('aria-label', toggle.title);
  toggle.setAttribute('aria-expanded', state.friendsCurrentCollapsed ? 'false' : 'true');
  wrap.appendChild(toggle);
}

function renderQueueRelay() {
  const relay = state.queueRelay || {};
  const view = queueRelayButtonView(relay);
  const start = $('queueRelayStart');
  start.disabled = view.disabled;
  start.textContent = view.label;
  start.title = view.detail;
  $('queueRelayDetail').textContent = view.detail;

  const connection = $('queueRelayConnection');
  connection.textContent = relay.connected
    ? 'Riot XMPP connected'
    : relay.connectionState === 'connecting'
      ? 'Connecting…'
      : relay.connectionState === 'error'
        ? 'Connection error'
        : 'Disconnected';
  connection.className = `queue-relay-connection ${relay.connected ? 'online' : relay.connectionState === 'error' ? 'error' : ''}`;

  const peers = $('queueRelayPeers');
  peers.innerHTML = '';
  if (!relay.lobby?.localIsLeader) return;
  for (const peer of relay.peers || []) {
    const row = el('div', 'queue-relay-peer');
    const main = el('div', 'queue-relay-peer-main');
    main.appendChild(el('div', 'queue-relay-peer-name', peer.riotId || peer.puuid?.slice(0, 8) || 'Lobby member'));
    main.appendChild(el('div', `queue-relay-peer-state ${peer.detected ? 'detected' : ''}`,
      peer.detected ? 'Queue Relay detected' : 'Queue Relay not detected'));
    row.appendChild(main);

    const permission = el('label', 'queue-relay-permission');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !!peer.allowed;
    checkbox.disabled = !peer.detected;
    permission.classList.toggle('disabled', checkbox.disabled);
    checkbox.addEventListener('change', async () => {
      checkbox.disabled = true;
      try {
        state.queueRelay = await api.setQueueRelayPermission(peer.puuid, checkbox.checked);
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        showMessage('Queue Relay permission failed', escapeHtml(friendly(error)));
      }
      renderQueueRelay();
    });
    permission.appendChild(checkbox);
    permission.appendChild(document.createTextNode('Allow queue starts'));
    permission.title = peer.detected
      ? 'Allow this Riot account to ask your Account Switcher to start matchmaking while you lead the same lobby.'
      : 'Permission becomes available after this lobby member\'s Queue Relay is detected.';
    row.appendChild(permission);
    peers.appendChild(row);
  }
}

async function startQueueViaLeader() {
  $('queueRelayStart').disabled = true;
  try {
    const result = await api.startViaLeader();
    showMessage('Queue Relay', escapeHtml(result?.message || 'The lobby leader started matchmaking.'));
  } catch (error) {
    showMessage('Queue Relay failed', escapeHtml(friendly(error)));
  } finally {
    state.queueRelay = await api.getQueueRelayStatus();
    renderQueueRelay();
  }
}

function handleFriendsPocProgress(progress) {
  if (!progress || typeof progress !== 'object') return;
  state.friendsPoc.progressRows = updateProgressRows(state.friendsPoc.progressRows || [], progress);
  state.friendsPoc.progress = progress;
  renderFriendsPocStatus();
}

function handleFriendsPocRanks(update) {
  const data = state.friendsPoc.data;
  if (!data || !update || update.generation !== data.rankGeneration) return;
  const ranksByPuuid = new Map((update.updates || []).map((item) => [String(item.puuid), item.ranks]));
  if (!ranksByPuuid.size) return;
  data.merged = data.merged.map((friend) => {
    const ranks = ranksByPuuid.get(String(friend.puuid || ''));
    return ranks ? { ...friend, ranks } : friend;
  });
  renderFriendsPoc();
}

function renderFriendsPocStatus() {
  const status = $('friendsPocStatus');
  const text = $('friendsPocProgressText');
  const progress = state.friendsPoc.progress;
  const view = progressLaneView({
    loading: state.friendsPoc.loading,
    progress,
    fallbackTotal: selectedFriendSourceIds().length,
    rows: state.friendsPoc.progressRows || [],
    expanded: state.friendsPoc.progressExpanded
  });
  const data = state.friendsPoc.data;
  status.className = 'friends-poc-status';
  status.classList.toggle('refreshing', view.active);
  $('friendsPocProgressCount').textContent = view.count;
  $('friendsPocProgressFill').style.width = `${view.percent}%`;

  const toggle = $('friendsPocProgressToggle');
  toggle.classList.toggle('hidden', !view.hasDetails);
  toggle.textContent = state.friendsPoc.progressExpanded ? 'Hide details' : 'Details';

  const log = $('friendsPocProgressLog');
  log.classList.toggle('hidden', !view.showDetails);
  log.innerHTML = '';
  if (view.showDetails) {
    for (const row of state.friendsPoc.progressRows || []) {
      const line = el('div', `friends-progress-line ${row.status}`);
      line.appendChild(el('span', 'friends-progress-account', row.label));
      line.appendChild(el('span', 'friends-progress-message', row.error || row.message));
      log.appendChild(line);
    }
  }

  if (state.friendsPoc.repairing) {
    const repair = state.friendsPoc.repairProgress || {};
    if (repair.phase === 'restoring') {
      text.textContent = 'Session repairs finished; restoring the account that was previously signed in…';
    } else if (repair.phase === 'account-start') {
      const failure = failedFriendSources().find((item) => item.accountId === repair.accountId);
      text.textContent = `Repairing ${repair.accountIndex}/${repair.accountTotal}: ${failure?.label || repair.accountId}…`;
    } else {
      text.textContent = 'Preparing background session repair…';
    }
    status.classList.add('loading');
  } else if (view.active) {
    text.textContent = view.headline;
  } else if (state.friendsPoc.loading) {
    text.textContent = `Refreshing ${selectedFriendSourceIds().length} saved-session friend list(s)...`;
    status.classList.add('loading');
  } else if (state.friendsPoc.error) {
    text.textContent = state.friendsPoc.error;
    status.classList.add('error');
  } else if (!data) {
    text.textContent = selectedFriendSourceIds().length
      ? 'Not refreshed yet.'
      : 'Select at least one saved-session source, then refresh.';
  } else {
    const friends = data.merged.filter((friend) => !friendIsCurrentAccount(friend));
    const onlineCount = friends.filter((friend) => friend.online).length;
    const offlineHidden = state.friendsPoc.showOffline ? 0 : friends.length - onlineCount;
    const mobileHidden = state.friendsPoc.showMobile ? 0 : friends.filter((friend) => friend.online && isMobileFriend(friend)).length;
    const failed = data.errors?.length || 0;
    text.textContent = `${friends.length} friends from ${data.accounts.length} source${data.accounts.length === 1 ? '' : 's'}` +
      ` — ${onlineCount} online${mobileHidden ? `, ${mobileHidden} on mobile hidden` : ''}` +
      `${offlineHidden ? `, ${offlineHidden} offline hidden` : ''}${failed ? `, ${failed} failed` : ''}.`;
    status.classList.toggle('error', failed > 0);
  }
}

function failedFriendSources() {
  return (state.friendsPoc.data?.errors || []).filter((failure) => failure.recommendedAction === 'reauthenticate');
}

// Keep the sources dropdown fully on-screen. It anchors to the picker button, which sits at the left
// of the toolbar but can shift as the toolbar wraps — so a fixed left- or right-alignment would clip
// the 330px menu off-screen. Clamp its offset against the viewport instead.
function positionFriendsAccountMenu() {
  const menu = $('friendsPocAccountMenu');
  const anchor = menu.parentElement.getBoundingClientRect(); // .friends-source-picker
  const margin = 12;
  const width = Math.min(330, window.innerWidth - margin * 2);
  const min = margin - anchor.left;
  const max = window.innerWidth - margin - width - anchor.left;
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.max(min, Math.min(0, max))}px`;
  menu.style.right = 'auto';
}

function renderFailedSessionAction() {
  const failed = failedFriendSources();
  const button = $('friendsPocFixFailed');
  button.classList.toggle('hidden', !failed.length);
  button.disabled = state.friendsPoc.loading || state.friendsPoc.repairing || state.status.busy;
  button.textContent = failed.length === 1 ? 'Fix failed session' : `Fix ${failed.length} failed sessions`;
  button.title = state.friendsPoc.repairing
    ? 'Wait for the current session repair to finish.'
    : state.friendsPoc.loading
    ? 'Wait for the current Friends refresh to finish.'
    : state.status.busy
      ? 'Wait for the current account action to finish.'
      : 'Sign in again to repair the failed saved session(s).';
}

function renderFriendsPoc() {
  const hoveredFriend = document.querySelector('.friend-row:hover');
  if (hoveredFriend) {
    if (!hoveredFriend.dataset.renderAfterHover) {
      hoveredFriend.dataset.renderAfterHover = '1';
      hoveredFriend.addEventListener('mouseleave', () => renderFriendsPoc(), { once: true });
    }
    return;
  }
  const accounts = $('friendsPocAccounts');
  const list = $('friendsPocList');
  accounts.innerHTML = '';
  list.innerHTML = '';
  $('friendsPocShowOffline').checked = !!state.friendsPoc.showOffline;
  $('friendsPocShowMobile').checked = !!state.friendsPoc.showMobile;
  renderFriendsPocSources();
  renderFriendsTabBadge();
  renderFriendsPocMeta();
  renderCurrentClientSummary();
  renderQueueRelay();
  renderFriendsPocStatus();
  renderFailedSessionAction();

  const data = state.friendsPoc.data;
  if (!data) return;

  const friends = data.merged.filter((friend) => !friendIsCurrentAccount(friend));
  const showMobile = !!state.friendsPoc.showMobile;

  const sourceView = friendSourceSummary(data.accounts, data.errors, {
    expanded: state.friendsPoc.sourcesExpanded,
    previewCount: 2,
    order: friendSourceOrder(state.layout)
  });
  accounts.classList.toggle('expanded', state.friendsPoc.sourcesExpanded);
  for (const item of sourceView.items) {
    accounts.appendChild(item.kind === 'account'
      ? renderFriendSourceAccount(item.account)
      : renderFriendSourceError(item.error));
  }
  if (sourceView.hiddenCount > 0 || (state.friendsPoc.sourcesExpanded && sourceView.totalCount > 2)) {
    const toggle = btn(
      state.friendsPoc.sourcesExpanded ? 'Show less' : `+${sourceView.hiddenCount} more`,
      'friend-source-toggle',
      false,
      () => {
        state.friendsPoc.sourcesExpanded = !state.friendsPoc.sourcesExpanded;
        renderFriendsPoc();
      }
    );
    toggle.title = state.friendsPoc.sourcesExpanded
      ? 'Collapse source accounts'
      : `${sourceView.hiddenCount} more source account${sourceView.hiddenCount === 1 ? '' : 's'}`;
    accounts.appendChild(toggle);
  }

  let visibleFriends = state.friendsPoc.showOffline
    ? friends
    : friends.filter((friend) => friend.online);
  // By default, drop friends who are only on the Riot mobile app so the list is just who's in the
  // League client; "Show mobile" brings them back. Mobile friends are online, so this also trims them
  // from the Show-offline view unless Show mobile is on.
  if (!showMobile) visibleFriends = visibleFriends.filter((friend) => !isMobileFriend(friend));
  visibleFriends = sortFriendsForFavorites(visibleFriends, state.settings.friendsPocFavoriteFriendKeys);

  if (!visibleFriends.length) {
    const empty = el('div', 'friend-empty', friends.length
      ? 'No friends to show. Try turning on Show mobile or Show offline.'
      : 'No friends found in these saved sessions.');
    list.appendChild(empty);
    return;
  }

  for (const friend of visibleFriends) {
    const tone = friendPresenceTone(friend);
    const row = el('div', `friend-row ${friend.online ? 'online' : 'offline'} presence-${tone}`);
    if (chatSourceOptions(friend).length) {
      row.title = row.title || `Right-click to chat with ${friend.riotId || friend.gameName || 'friend'}`;
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeFriendSourceSwitchMenu();
        openChatSourcePicker(friend);
      });
    }
    const main = el('div', 'friend-main');
    const title = el('span', 'friend-title');
    title.appendChild(renderFriendFavoriteButton(friend));
    title.appendChild(el('span', `friend-online-dot ${friend.online ? 'on' : ''} presence-${tone}`));
    title.appendChild(el('span', 'friend-name', friend.riotId || 'Unknown friend'));
    main.appendChild(title);
    const stateRow = el('div', 'friend-state-row');
    const stateLine = el('span', `friend-state presence-${tone}`, friendStateText(friend));
    const spectatorHover = (
      state.settings.friendsSpectatorStats
      && friend.activity?.kind === 'inGame'
    );
    const activityTip = friendActivityTooltip(friend);
    if (activityTip && !spectatorHover) {
      stateLine.title = activityTip;
      row.title = activityTip;
    }
    if (spectatorHover) row.removeAttribute('title');
    stateRow.appendChild(stateLine);
    const occupancy = friendLobbyOccupancy(friend);
    if (occupancy) {
      const badge = el('span', 'friend-lobby-size', occupancy);
      badge.title = `Lobby occupancy: ${occupancy}`;
      badge.setAttribute('aria-label', badge.title);
      stateRow.appendChild(badge);
    }
    main.appendChild(stateRow);
    row.appendChild(main);

    // Keep ranks in a dedicated column instead of inside the name. This aligns every crest and
    // gives long names and activity text a predictable boundary at compact window widths.
    const rankSlot = el('div', 'friend-rank-slot');
    const friendRank = renderFriendSmartRank(friend);
    if (friendRank) rankSlot.appendChild(friendRank);
    row.appendChild(rankSlot);

    const seen = friend.seenFrom || [];
    const side = el('div', 'friend-side');
    const sources = el('div', 'friend-sources');
    const seenLabels = seen.map((source) => typeof source === 'string' ? source : source?.label).filter(Boolean);
    sources.title = `Friends with: ${seenLabels.join(', ')}`;
    const playingWith = playingWithFriends(friend);
    const chatButton = renderFriendChatButton(friend);
    const joinButton = renderFriendJoinButton(friend);
    const inviteButton = renderFriendInviteButton(friend);
    const secondaryActionCount = [joinButton, inviteButton].filter(Boolean).length;
    if (chatButton && secondaryActionCount) compactFriendChatButton(chatButton);
    if (secondaryActionCount > 1) sources.classList.add('crowded');
    if (playingWith.length) {
      const label = playingWithBadgeLabel(playingWith.length, { compact: window.innerWidth <= 520 });
      const badge = el('span', 'friend-source-badge playing-with', label);
      badge.title = `Playing with: ${playingWith.join(', ')}`;
      sources.appendChild(badge);
    }
    const loginCounts = Object.fromEntries((state.stats.accounts || [])
      .map((account) => [account.accountId, account.loginCount]));
    const sourceView = friendCardSourceSummary(seen, {
      loginCounts,
      order: friendSourceOrder(state.layout)
    });
    for (const source of sourceView.shown) {
      const badge = el('button', 'friend-source-badge', source.label);
      badge.type = 'button';
      const isCurrent = source.accountId && source.accountId === state.currentClient?.accountId;
      badge.disabled = !source.accountId || isCurrent || !!state.status.busy;
      badge.title = isCurrent
        ? `${source.label} is currently signed in`
        : state.status.busy
          ? 'Wait for the current account switch to finish'
          : `Switch to ${source.label}`;
      badge.addEventListener('click', () => doSwitch(source.accountId));
      sources.appendChild(badge);
    }
    if (sourceView.hidden.length) {
      const more = el('span', 'friend-source-badge more', `+${sourceView.hidden.length}`);
      more.title = `${sourceView.hidden.map((source) => source.label).join(', ')} — right-click to switch`;
      more.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openFriendSourceSwitchMenu(sourceView.all, event.clientX, event.clientY);
      });
      sources.appendChild(more);
    }
    side.appendChild(sources);
    if (chatButton) side.appendChild(chatButton);
    if (joinButton) side.appendChild(joinButton);
    if (inviteButton) side.appendChild(inviteButton);
    row.appendChild(side);
    if (spectatorHover) attachFriendSpectatorStats(row, stateLine, friend);
    list.appendChild(row);
  }
}

function spectatorPanelFriend(panel) {
  const puuid = panel.dataset.friendPuuid || '';
  const riotId = panel.dataset.friendRiotId || '';
  return (state.friendsPoc.data?.merged || []).find((friend) => (
    (puuid && String(friend.puuid || '') === puuid)
    || (!puuid && riotId && String(friend.riotId || '') === riotId)
  )) || null;
}

function spectatorMetric(label, value) {
  const row = el('span', 'friend-game-stats-metric');
  row.appendChild(el('span', 'metric-label', label));
  row.appendChild(el('span', 'metric-value', value === null ? '—' : String(value)));
  return row;
}

function renderSpectatorStatsPanel(panel, friend, now = Date.now()) {
  const view = friendSpectatorStatsView(friend, state.spectatorStats, now);
  panel.replaceChildren();
  if (!view) {
    panel.classList.remove('open');
    return;
  }

  if (view.freshnessLine) {
    panel.appendChild(el('span', 'friend-game-stats-freshness', view.freshnessLine));
  }
  panel.appendChild(el('span', 'friend-game-stats-context', view.context));
  if (view.statusMessage) {
    panel.appendChild(el(
      'span',
      `friend-game-stats-message status-${view.status}`,
      view.statusMessage
    ));
  }
  if (view.friend) {
    const player = el('span', 'friend-game-stats-player');
    player.appendChild(el(
      'span',
      'player-champion',
      `${view.friend.championName} · Level ${view.friend.level}`
    ));
    player.appendChild(el(
      'span',
      'player-score',
      `${view.friend.kills} / ${view.friend.deaths} / ${view.friend.assists} · ${view.friend.cs} CS`
    ));
    panel.appendChild(player);
  } else if (view.friendUnavailable) {
    panel.appendChild(el('span', 'friend-game-stats-message status-error', view.friendUnavailable));
  }

  if (view.teams?.length) {
    const teams = el('span', 'friend-game-stats-teams');
    for (const team of view.teams) {
      const card = el(
        'span',
        `friend-game-stats-team team-${team.teamId}${team.ally ? ' ally' : ''}`
      );
      card.appendChild(el(
        'span',
        'team-title',
        `${team.label}${team.ally ? ' · Friend' : ''}`
      ));
      card.appendChild(spectatorMetric('Kills', team.kills));
      card.appendChild(spectatorMetric('Towers', team.towers));
      card.appendChild(spectatorMetric('Dragons', team.objectives.dragons));
      card.appendChild(spectatorMetric('Barons', team.objectives.barons));
      card.appendChild(spectatorMetric('Heralds', team.objectives.riftHeralds));
      card.appendChild(spectatorMetric('Void Grubs', team.objectives.voidGrubs));
      card.appendChild(spectatorMetric('Atakhan', team.objectives.atakhan));
      teams.appendChild(card);
    }
    panel.appendChild(teams);
  }
}

function positionSpectatorStatsPanel(panel) {
  panel.classList.remove('below');
  const above = panel.getBoundingClientRect();
  if (above.top < 8) panel.classList.add('below');
}

function refreshOpenSpectatorStatsTips() {
  for (const panel of document.querySelectorAll('.friend-game-stats-tip.open')) {
    const friend = spectatorPanelFriend(panel);
    if (friend) renderSpectatorStatsPanel(panel, friend);
  }
}

function attachFriendSpectatorStats(row, stateLine, friend) {
  const panel = el('span', 'friend-game-stats-tip');
  panel.dataset.friendPuuid = String(friend.puuid || '');
  panel.dataset.friendRiotId = String(friend.riotId || '');
  renderSpectatorStatsPanel(panel, friend);
  row.appendChild(panel);

  stateLine.classList.add('spectator-stats-target');
  stateLine.tabIndex = 0;
  stateLine.setAttribute('aria-label', `${friendStateText(friend)}; show delayed game score`);
  let pointerOpen = false;
  let focusOpen = false;
  const syncOpen = () => {
    const open = pointerOpen || focusOpen;
    panel.classList.toggle('open', open);
    stateLine.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) return;
    renderSpectatorStatsPanel(panel, friend);
    requestAnimationFrame(() => positionSpectatorStatsPanel(panel));
  };
  stateLine.addEventListener('mouseenter', () => {
    pointerOpen = true;
    syncOpen();
  });
  stateLine.addEventListener('mouseleave', () => {
    pointerOpen = false;
    syncOpen();
  });
  stateLine.addEventListener('focus', () => {
    focusOpen = true;
    syncOpen();
  });
  stateLine.addEventListener('blur', () => {
    focusOpen = false;
    syncOpen();
  });
}

function renderFriendSmartRank(friend) {
  const view = smartFriendRankView(friend);
  if (!view) return null;
  const emblem = el('span', `friend-rank-smart ${view.state} ${view.active ? 'active-queue' : ''}`);
  const img = document.createElement('img');
  img.src = view.img;
  img.alt = view.active ? `${view.label} rank — currently playing` : `${view.label} rank`;
  img.draggable = false;
  emblem.appendChild(img);
  if (view.overlay) emblem.appendChild(el('span', 'friend-rank-div', view.overlay));
  const tip = el('span', 'friend-rank-tip');
  tip.appendChild(el('span', 'tip-queue', view.tip[0]));
  for (const line of view.tip.slice(1)) tip.appendChild(el('span', 'tip-line', line));
  emblem.appendChild(tip);
  emblem.setAttribute('aria-label', view.active ? `Currently playing ${view.label}; show rank details` : `${view.label}; show rank details`);
  return emblem;
}

function renderFriendSourceAccount(account) {
  const chip = el('div', `friend-source${account.onlineCount ? '' : ' idle'}`);
  chip.appendChild(el('span', 'friend-source-dot'));
  chip.appendChild(el('span', 'friend-source-name', account.label));
  chip.appendChild(el('span', 'friend-source-count', `${account.onlineCount || 0}/${account.friends.length}`));
  chip.title = account.riotId || account.label;
  return chip;
}

function renderFriendSourceError(failure) {
  const chip = el('div', 'friend-source failed');
  chip.appendChild(el('span', 'friend-source-dot'));
  chip.appendChild(el('span', 'friend-source-name', failure.label));
  chip.appendChild(el('span', 'friend-source-count', friendFailureActionLabel(failure)));
  chip.title = `${failure.error || failure.label}${failure.category ? ` (${failure.category})` : ''}`;
  return chip;
}

function renderFriendFavoriteButton(friend) {
  const favorite = isFavoriteFriend(friend, state.settings.friendsPocFavoriteFriendKeys);
  const label = favorite ? '★' : '☆';
  const button = btn(label, `friend-favorite-btn ${favorite ? 'active' : ''}`, false, (event) => {
    event.stopPropagation();
    toggleFriendFavorite(friend);
  });
  button.title = favorite
    ? `Remove ${friend.riotId || friend.gameName || 'friend'} from favorites`
    : `Favorite ${friend.riotId || friend.gameName || 'friend'}`;
  button.setAttribute('aria-label', button.title);
  return button;
}

function renderFriendJoinButton(friend) {
  const view = friendJoinView(friend, friendActionLobbyStatus(), state.friendJoinState);
  if (!view.visible) return null;
  // A generic disabled "Unavailable" repeats the account/client status already shown above the list
  // and becomes especially noisy beside Chat. Keep actionable and specific lobby states instead.
  if (view.status === 'unavailable' && view.label === 'Unavailable') return null;
  const button = btn(view.label, `btn small friend-action-btn friend-join-btn ${view.status}`, view.disabled, (event) => {
    event.stopPropagation();
    joinFriendLobbyFromRow(friend);
  });
  button.title = view.title || 'Join lobby';
  button.setAttribute('aria-label', button.title);
  return button;
}

function renderFriendChatButton(friend) {
  if (!chatSourceOptions(friend).length) return null;
  const button = btn('Chat', 'btn small friend-chat-btn', false, (event) => {
    event.stopPropagation();
    openChatSourcePicker(friend);
  });
  button.title = `Chat with ${friend.riotId || friend.gameName || 'friend'}`;
  button.setAttribute('aria-label', button.title);
  return button;
}

function compactFriendChatButton(button) {
  button.classList.add('compact');
  button.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 4.5h13v8.25h-7l-3.75 3v-3H3.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
}

function renderFriendInviteButton(friend) {
  if (!canShowFriendInvite(friend)) return null;
  const key = friendInviteKey(friend);
  const invite = state.friendInviteState[key] || {};
  const status = invite.status || 'idle';
  const disabled = status === 'pending' || status === 'sent';
  const label = invite.message || 'Invite';
  const button = btn(label, `btn small friend-invite-btn ${status}`, disabled, (event) => {
    event.stopPropagation();
    inviteFriendToCurrentLobby(friend);
  });
  button.title = invite.title
    || (status === 'pending'
      ? 'The invitation is being sent.'
      : status === 'sent'
        ? 'The invitation has already been sent.'
        : `Invite ${friend.riotId || friend.gameName || 'friend'} to current lobby`);
  button.setAttribute('aria-label', button.title);
  return button;
}

async function updateFriendSourceSelection(accountId, checked) {
  const next = new Set(state.settings.friendsPocSelectedAccountIds || []);
  if (checked) next.add(accountId);
  else next.delete(accountId);
  state.settings = await api.setSettings({
    friendsPocUseAllAccounts: false,
    friendsPocSelectedAccountIds: [...next],
    friendsPocSelectionInitialized: true
  });
  renderFriendsPoc();
}

async function toggleFriendFavorite(friend) {
  const key = friendFavoriteKey(friend);
  if (!key) return;
  const next = new Set(state.settings.friendsPocFavoriteFriendKeys || []);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  state.settings = await api.setSettings({ friendsPocFavoriteFriendKeys: [...next] });
  renderFriendsPoc();
}

async function setFriendsUseAllSources(useAll) {
  state.settings = await api.setSettings({
    friendsPocUseAllAccounts: useAll,
    friendsPocSelectionInitialized: true
  });
  renderFriendsPoc();
}

function formatTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function relativeAge(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'unknown';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return '';
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

// ---------------------------------------------------------------------------
// Update banner
// ---------------------------------------------------------------------------
function renderUpdateBanner() {
  const view = nextUpdateView(state.updateStatus, state.updateDismissed, state.settings.autoUpdate);
  const banner = $('updateBanner');
  if (updateTransientTimer) { clearTimeout(updateTransientTimer); updateTransientTimer = null; }

  if (!view.visible) {
    banner.classList.add('hidden');
    return;
  }

  $('updateText').textContent = view.text;
  const actions = $('updateActions');
  actions.innerHTML = '';
  if (view.action === 'download') {
    actions.appendChild(btn('Update now', 'btn primary small', false, () => api.downloadUpdate()));
  } else if (view.action === 'install') {
    actions.appendChild(btn('Restart now', 'btn primary small', false, () => api.installUpdate()));
  }
  if (view.dismissible) {
    actions.appendChild(noticeCloseBtn(() => {
      state.updateDismissed = true;
      renderUpdateBanner();
    }));
  }
  banner.classList.remove('hidden');

  // Transient feedback (checking / up-to-date / error) auto-hides after a few seconds.
  if (view.transient) {
    updateTransientTimer = setTimeout(() => {
      $('updateBanner').classList.add('hidden');
      updateTransientTimer = null;
    }, 4000);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function doSwitch(id, force = false) {
  try {
    await api.switchAccount(id, force);
    state.status = await api.getStatus();
    renderStatus();
    renderAccounts();
  } catch (error) {
    showMessage('Could not switch', friendly(error));
  }
}

async function retryCurrentSwitch() {
  try {
    state.status = {
      ...state.status,
      stage: 'restarting',
      message: `Retrying login for ${state.status.label || 'this account'}… closing Riot/League first.`
    };
    renderStatus();
    state.status = await api.restartCurrentSwitch();
    renderStatus();
    renderAccounts();
    renderFriendsPoc();
  } catch (error) {
    showMessage('Could not retry login typing', friendly(error));
  }
}

async function doCapture(account) {
  const signedIn = await api.getSignedInName().catch(() => null);
  const storedName = String(account.lastSummonerName || '').trim();
  const storedUsername = String(account.username || '').trim();
  const hasComparableName = storedName && storedName.toLowerCase() !== storedUsername.toLowerCase();
  const mismatch = !!(signedIn && hasComparableName &&
    signedIn.trim().toLowerCase() !== storedName.toLowerCase());

  let body;
  if (mismatch) {
    body = `⚠ The Riot Client is signed in as <b>${escapeHtml(signedIn)}</b>, which doesn't match ` +
      `<b>${escapeHtml(account.label)}</b> (${escapeHtml(account.lastSummonerName)}). Capturing will ` +
      `<b>overwrite</b> this account with the ${escapeHtml(signedIn)} session. Capture anyway?`;
  } else {
    const who = signedIn ? `signed in as <b>${escapeHtml(signedIn)}</b>` : 'currently signed in';
    body = `This saves the session ${who} into <b>${escapeHtml(account.label)}</b> and closes the ` +
      `Riot Client. Make sure you're signed in as this account. Continue?`;
  }
  const ok = await confirmDialog('Capture session', body, mismatch ? 'Capture anyway' : 'Capture');
  if (!ok) return;

  try {
    setStatusBusy('Capturing session… the Riot Client will close.');
    let result = await api.captureAccount(account.id, mismatch);
    // Backstop: the core also blocks a mismatch (e.g. if we couldn't read the name above).
    if (result && result.mismatch) {
      clearTransientStatus();
      const ok2 = await confirmDialog('Different account signed in',
        `${escapeHtml(result.warning)} Capture anyway?`, 'Capture anyway');
      if (!ok2) return;
      setStatusBusy('Capturing session… the Riot Client will close.');
      result = await api.captureAccount(account.id, true);
    }
    clearTransientStatus();
    await reloadAccounts();
    if (result && result.persisted === false) {
      showMessage('No saved session found', result.warning ||
        'No "Stay signed in" session was found. Sign in with "Stay signed in" checked, then capture again.');
    } else {
      showMessage('Session captured', `Saved a fresh session for <b>${escapeHtml(account.label)}</b>.`);
    }
  } catch (error) {
    clearTransientStatus();
    showMessage('Capture failed', friendly(error));
  }
}

async function refreshFriendsPoc({ reason = 'manual', silentIfNoSources = false } = {}) {
  if (state.friendsPoc.loading) return;
  clearFriendsAutoRefreshTimer();
  const accountIds = selectedFriendSourceIds();
  if (!accountIds.length) {
    if (!silentIfNoSources) {
      state.friendsPoc = { ...state.friendsPoc, loading: false, error: 'Select at least one saved-session source first.' };
      renderFriendsPoc();
    }
    scheduleFriendsAutoRefresh();
    return;
  }
  const autoRefresh = reason === 'auto';
  state.friendsPoc = {
    ...state.friendsPoc,
    loading: true,
    error: null,
    progress: {
      phase: 'refresh-start',
      accountDone: 0,
      accountTotal: accountIds.length,
      message: `Starting friend refresh for ${accountIds.length} account${accountIds.length === 1 ? '' : 's'}`
    },
    progressRows: [],
    progressExpanded: false
  };
  $('friendsPocRefresh').disabled = true;
  renderFriendsPocSources();
  renderFriendsPocStatus();
  renderFailedSessionAction();
  try {
    const data = await api.refreshFriendsPoc({ accountIds });
    const finishedAt = Date.now();
    state.friendsPoc = {
      ...state.friendsPoc,
      loading: false,
      data,
      error: null,
      progress: null,
      lastRefreshAt: finishedAt,
      lastAutoRefreshAt: autoRefresh ? finishedAt : state.friendsPoc.lastAutoRefreshAt
    };
    state.friendJoinState = {};
  } catch (error) {
    const finishedAt = Date.now();
    state.friendsPoc = {
      ...state.friendsPoc,
      loading: false,
      error: friendly(error),
      progress: null,
      lastRefreshAt: finishedAt,
      lastAutoRefreshAt: autoRefresh ? finishedAt : state.friendsPoc.lastAutoRefreshAt
    };
  } finally {
    $('friendsPocRefresh').disabled = false;
    renderFriendsPocSources();
    renderFriendsPocStatus();
    renderFailedSessionAction();
    renderFriendsPoc();
    scheduleFriendsAutoRefresh();
  }
}

function refreshFriendsPocFromTabClick() {
  if (!shouldRefreshFriendsOnTabClick({
    selectedSourceCount: selectedFriendSourceIds().length,
    loading: state.friendsPoc.loading,
    lastAutoRefreshAt: state.friendsPoc.lastAutoRefreshAt
  })) return;
  refreshFriendsPoc({ reason: 'tab-click', silentIfNoSources: true });
}

async function joinFriendLobbyFromRow(friend) {
  const payload = friendJoinPayload(friend);
  if (!payload) return;
  const key = friendJoinKey(friend);
  if (shouldConfirmLobbyJoin(payload, friendActionLobbyStatus())) {
    const ok = await confirmDialog(
      'Join lobby',
      `You are already in a lobby with ${state.friendsPocLobby.memberPuuids.length} players. ` +
        `Join <b>${escapeHtml(friend.riotId || 'this friend')}</b>'s lobby instead?`,
      'Join lobby'
    );
    if (!ok) return;
  }

  state.friendJoinState = { ...state.friendJoinState, [key]: { status: 'pending' } };
  renderFriendsPoc();
  try {
    const result = await api.joinFriendLobby(payload);
    state.friendJoinState = { ...state.friendJoinState, [key]: { status: 'joined' } };
    setTimeout(() => {
      if (state.friendJoinState[key]?.status !== 'joined') return;
      const next = { ...state.friendJoinState };
      delete next[key];
      state.friendJoinState = next;
      renderFriendsPoc();
    }, 5000);
    return result;
  } catch (error) {
    const message = friendly(error);
    state.friendJoinState = { ...state.friendJoinState, [key]: { status: 'error', title: message } };
    showMessage('Join failed', escapeHtml(message));
  } finally {
    await refreshFriendsLocalContext();
  }
}

async function inviteFriendToCurrentLobby(friend) {
  const key = friendInviteKey(friend);
  if (!key) return;
  state.friendInviteState = { ...state.friendInviteState, [key]: { status: 'pending', message: 'Inviting' } };
  renderFriendsPoc();
  try {
    const result = await api.inviteFriendToLobby({
      puuid: friend.puuid || '',
      gameName: friend.gameName || '',
      tagLine: friend.tagLine || '',
      riotId: friend.riotId || ''
    });
    state.friendInviteState = { ...state.friendInviteState, [key]: { status: 'sent', message: 'Sent' } };
    setTimeout(() => {
      if (state.friendInviteState[key]?.status !== 'sent') return;
      const next = { ...state.friendInviteState };
      delete next[key];
      state.friendInviteState = next;
      renderFriendsPoc();
    }, 5000);
    return result;
  } catch (error) {
    const message = friendly(error);
    state.friendInviteState = { ...state.friendInviteState, [key]: { status: 'error', message: 'Retry', title: message } };
    showMessage('Invite failed', escapeHtml(message));
  } finally {
    await refreshFriendsLocalContext();
  }
}

async function fixFailedFriendSessions() {
  const failed = failedFriendSources();
  if (!failed.length) return;
  const ok = await confirmDialog(
    'Fix failed sessions',
    `Riot rejected the reusable Friends session for ${failed.length} account${failed.length === 1 ? '' : 's'}. ` +
      `Re-login them now? The app will use Riot Client without launching League, auto-type each login with ` +
      `<b>"Stay signed in"</b> checked, validate the refreshed session, then return to the account that is currently signed in. ` +
      `Riot is only brought forward if background input fails.`,
    'Re-login'
  );
  if (!ok) return;

  state.friendsPoc.repairing = true;
  state.friendsPoc.repairProgress = null;
  renderFriendsPoc();
  try {
    const result = await api.repairFriendsSessions(failed.map((failure) => failure.accountId));
    state.friendsPoc.repairing = false;
    state.friendsPoc.repairProgress = null;
    await reloadAccounts();
    if (result.fixed.length) await refreshFriendsPoc();
    const fixedLabels = result.fixed.map((item) => item.label);
    if (result.failed.length || !result.restoration?.restored) {
      const fixedText = fixedLabels.length ? `Re-logged in: <b>${escapeHtml(fixedLabels.join(', '))}</b>.<br><br>` : '';
      const failedText = result.failed
        .map((item) => `<b>${escapeHtml(item.label)}</b>: ${escapeHtml(item.error)}`)
        .join('<br>');
      const restoreText = result.restoration?.restored
        ? ''
        : `<br><br><b>Original account restoration:</b> ${escapeHtml(result.restoration?.reason || 'did not finish')}`;
      showMessage('Fix failed sessions', `${fixedText}${failedText ? `Still failed:<br>${failedText}` : ''}${restoreText}`);
    } else {
      showMessage('Fix failed sessions', `Re-logged in: <b>${escapeHtml(fixedLabels.join(', '))}</b>.<br><br>The friendlist has been refreshed and your previous account state restored.`);
    }
  } catch (error) {
    state.friendsPoc.repairing = false;
    state.friendsPoc.repairProgress = null;
    renderFriendsPoc();
    showMessage('Fix failed sessions', escapeHtml(friendly(error)));
  }
}

async function doDelete(account) {
  const ok = await confirmDialog(
    'Delete account',
    `Remove <b>${escapeHtml(account.label)}</b> and its saved session? This can't be undone.`,
    'Delete'
  );
  if (!ok) return;
  try {
    await api.removeAccount(account.id);
    await reloadAccounts();
  } catch (error) {
    showMessage('Could not delete', friendly(error));
  }
}

// ---------------------------------------------------------------------------
// Add / Edit form
// ---------------------------------------------------------------------------
function openForm(account = null) {
  state.editingId = account ? account.id : null;
  $('formTitle').textContent = account ? 'Edit account' : 'Add account';
  $('fLabel').value = account ? account.label : '';
  $('fUsername').value = account ? (account.username || '') : '';
  $('fPassword').value = '';
  $('fPassword').placeholder = account && account.hasPassword
    ? 'Leave blank to keep current password'
    : 'Leave blank to skip';
  $('fRegion').value = account && account.region ? account.region : state.settings.defaultRegion;
  setFormMsg('');
  $('formOverlay').classList.remove('hidden');
  $('fLabel').focus();
}

function closeForm() {
  $('formOverlay').classList.add('hidden');
  state.editingId = null;
}

async function saveForm() {
  const username = $('fUsername').value.trim();
  const label = $('fLabel').value.trim();
  if (!username && !label) {
    setFormMsg('Enter at least a label or a Riot username.', true);
    return;
  }
  const payload = {
    id: state.editingId || undefined,
    label,
    username,
    region: $('fRegion').value,
    password: $('fPassword').value // empty string keeps existing (handled in core)
  };
  try {
    await api.saveAccount(payload);
    closeForm();
    await reloadAccounts();
  } catch (error) {
    setFormMsg(friendly(error), true);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const FRIENDS_AUTO_REFRESH_DEFAULT_MS = 60_000;
const FRIENDS_AUTO_REFRESH_MIN_MS = 15_000;
const FRIENDS_AUTO_REFRESH_MAX_MS = 60 * 60_000;

function normalizeFriendsAutoRefreshMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return FRIENDS_AUTO_REFRESH_DEFAULT_MS;
  return Math.min(FRIENDS_AUTO_REFRESH_MAX_MS, Math.max(FRIENDS_AUTO_REFRESH_MIN_MS, Math.round(ms)));
}

function friendsAutoRefreshMs() {
  return normalizeFriendsAutoRefreshMs(state.settings.friendsPocAutoRefreshMs);
}

function lastFriendsRefreshAt() {
  const last = Number(state.friendsPoc.lastRefreshAt);
  if (Number.isFinite(last) && last > 0) return last;
  const parsed = Date.parse(state.friendsPoc.data?.refreshedAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function friendsAutoRefreshDelayFromLastRefresh() {
  return friendsAutoRefreshDelay({
    lastRefreshAt: lastFriendsRefreshAt(),
    intervalMs: friendsAutoRefreshMs()
  });
}

function clearFriendsAutoRefreshTimer() {
  if (!friendsAutoRefreshTimer) return;
  clearTimeout(friendsAutoRefreshTimer);
  friendsAutoRefreshTimer = null;
}

function syncFriendsAutoRefreshControls() {
  const enabled = !!state.settings.friendsPocAutoRefresh;
  $('friendsPocAutoRefresh').checked = enabled;
  $('friendsPocAutoRefreshSeconds').value = String(Math.round(friendsAutoRefreshMs() / 1000));
  $('friendsPocAutoRefreshSeconds').disabled = !enabled;
}

function scheduleFriendsAutoRefresh({ refreshIfDue = false } = {}) {
  clearFriendsAutoRefreshTimer();
  syncFriendsAutoRefreshControls();
  if (!state.settings.friendsPocAutoRefresh || state.friendsPoc.loading) return;
  const delay = refreshIfDue ? friendsAutoRefreshDelayFromLastRefresh() : friendsAutoRefreshMs();
  if (refreshIfDue && delay <= 0) {
    refreshFriendsPoc({ reason: 'auto' });
    return;
  }
  friendsAutoRefreshTimer = setTimeout(() => {
    friendsAutoRefreshTimer = null;
    refreshFriendsPoc({ reason: 'auto' });
  }, delay);
}

async function onSettingChange(patch, options = {}) {
  state.settings = await api.setSettings(patch);
  $('defaultRegion').value = state.settings.defaultRegion;
  $('startWithWindows').checked = !!state.settings.startWithWindows;
  $('autoUpdate').checked = !!state.settings.autoUpdate;
  $('autoAcceptDelay').value = Math.round((state.settings.autoAcceptDelayMs ?? 2000) / 1000);
  renderAutoAcceptSoundSetting();
  renderClientCleanupSetting();
  $('friendsPocAggressiveFetching').checked = !!state.settings.friendsPocAggressiveFetching;
  $('friendsSpectatorStats').checked = !!state.settings.friendsSpectatorStats;
  $('chatOnlineLeaseSeconds').value = Math.round((state.settings.chatOnlineLeaseMs ?? 180_000) / 1_000);
  syncFriendsAutoRefreshControls();
  scheduleFriendsAutoRefresh({ refreshIfDue: !!options.refreshFriendsAutoRefreshIfDue });
  renderClientToggles();
  renderUpdateBanner(); // autoUpdate affects banner text/actions
  renderFriendsPoc();
}

function renderAutoAcceptSoundSetting() {
  const enabled = !!state.settings.autoAcceptSound;
  const volume = Math.min(100, Math.max(0, Number(state.settings.autoAcceptSoundVolume) || 0));
  $('autoAcceptSound').checked = enabled;
  $('autoAcceptSoundVolume').value = volume;
  $('autoAcceptSoundVolumeValue').textContent = `${volume}%`;
  $('autoAcceptSoundVolumeRow').classList.toggle('hidden', !enabled);
}

function playAutoAcceptSound() {
  if (!state.settings.autoAcceptSound) return;
  playNotificationTones([[660, 0], [880, 0.16]], {
    duration: 0.45,
    fadeAt: 0.65,
    gainScale: 0.22,
    oscillatorType: 'sine'
  });
}

function playQueueDodgeSound() {
  if (!state.settings.autoAcceptSound) return;
  playNotificationTones([[520, 0], [390, 0.16], [260, 0.32]], {
    duration: 0.34,
    fadeAt: 0.72,
    gainScale: 0.2,
    oscillatorType: 'triangle'
  });
}

function playNotificationTones(tones, { duration, fadeAt, gainScale, oscillatorType }) {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext();
  const gain = context.createGain();
  const volume = Math.min(1, Math.max(0, Number(state.settings.autoAcceptSoundVolume) / 100));
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * gainScale), context.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + fadeAt);
  gain.connect(context.destination);
  for (const [frequency, offset] of tones) {
    const oscillator = context.createOscillator();
    oscillator.type = oscillatorType;
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    oscillator.start(context.currentTime + offset);
    oscillator.stop(context.currentTime + offset + duration);
  }
  setTimeout(() => context.close(), Math.ceil((fadeAt + 0.25) * 1_000));
}

const CLIENT_CLEANUP_DEFAULT_HINT = 'Uses client APIs; rendered dots may disappear after the next client session';

function renderClientCleanupSetting() {
  $('autoClientCleanup').checked = !!state.settings.autoClientCleanup;
}

function setClientCleanupHint(message, { reset = true } = {}) {
  if (clientCleanupHintTimer) {
    clearTimeout(clientCleanupHintTimer);
    clientCleanupHintTimer = null;
  }
  $('clientCleanupHint').textContent = message || CLIENT_CLEANUP_DEFAULT_HINT;
  if (reset) {
    clientCleanupHintTimer = setTimeout(() => {
      clientCleanupHintTimer = null;
      $('clientCleanupHint').textContent = CLIENT_CLEANUP_DEFAULT_HINT;
    }, 7_000);
  }
}

function clientCleanupResultText(result, { deep = false } = {}) {
  if (!result || result.status === 'unavailable') return 'League client is not ready.';
  const blockedReason = result.uiNavigation?.blockedReason
    ? String(result.uiNavigation.blockedReason)
    : '';
  const phasePrefix = 'gameflow-phase:';
  const blockedPhase = blockedReason.startsWith(phasePrefix)
    ? blockedReason.slice(phasePrefix.length)
    : null;
  if (result.status === 'blocked') {
    if (!deep) return 'Paused during ready check, champ select, and games — try again afterwards.';
    return blockedPhase
      ? `Deep-clean visits were skipped — League must be fully idle (phase None; current phase: ${blockedPhase}).`
      : 'Deep-clean visits were skipped — League must be fully idle (phase None).';
  }

  const parts = [];
  const notes = [];
  const visitParts = [];
  const visitsSent = result.uiNavigation?.visitsSent;
  const visitLabels = {
    home: 'League home',
    collection: 'Collection',
    tft: 'TFT',
    tftStore: 'TFT Store'
  };
  const clearedLabels = {
    home: 'the League home notices',
    collection: 'the Collection dot',
    tft: 'the TFT notice'
  };

  for (const target of Object.keys(visitLabels)) {
    if (visitsSent?.[target]) visitParts.push(`${visitLabels[target]} visit sent`);
  }
  for (const target of Object.keys(clearedLabels)) {
    if (visitsSent?.[target] || !result.cleared?.[target]) continue;
    if (result.headerClearModes?.[target] === 'background') {
      visitParts.push(`${visitLabels[target]} visit sent`);
    } else {
      parts.push(`cleared ${clearedLabels[target]}`);
    }
  }

  const count = Number(result.claimedRewardCount) || 0;
  if (count) parts.push(`Claimed ${count} pass reward${count === 1 ? '' : 's'}`);
  const viewedMissions = Number(result.viewedMissionCount) || 0;
  if (viewedMissions) {
    parts.push(`marked ${viewedMissions} mission notice${viewedMissions === 1 ? '' : 's'} as seen`);
  }

  const persistedHomeCount = Array.isArray(result.homePersistedIds)
    ? result.homePersistedIds.length
    : 0;
  if (persistedHomeCount) {
    const nextSession = visitsSent?.home ? '' : ' for the next client session';
    parts.push(`saved ${persistedHomeCount} League home notice${persistedHomeCount === 1 ? '' : 's'} as seen${nextSession}`);
  }

  const collectionSeenCount = Array.isArray(result.collectionSeenCategories)
    ? result.collectionSeenCategories.length
    : 0;
  if (collectionSeenCount) {
    parts.push(`saved ${collectionSeenCount} Collection update${collectionSeenCount === 1 ? '' : 's'} as seen`);
  }

  const persistedTftCategories = Array.isArray(result.tftSeenCategories)
    ? result.tftSeenCategories.filter((category) => ![
      'offers',
      'store',
      'offer-placeholder'
    ].includes(category))
    : [];
  if (persistedTftCategories.length) {
    parts.push(`marked ${persistedTftCategories.length} TFT update${persistedTftCategories.length === 1 ? '' : 's'} as seen`);
  }

  const nextSessionTftCount = Array.isArray(result.tftNextSessionReasons)
    ? result.tftNextSessionReasons.length
    : 0;
  if (nextSessionTftCount) {
    const experimental = result.tftOfferPlaceholderApplied
      ? ' (including the experimental offer marker)'
      : '';
    parts.push(`saved ${nextSessionTftCount} TFT update${nextSessionTftCount === 1 ? '' : 's'} for the next client session${experimental}`);
  } else if (result.tftOfferPlaceholderApplied) {
    parts.push('saved the experimental TFT offer marker for the next client session');
  }

  if (result.cleared?.profile) parts.push('marked the profile notices as seen');
  const dismissed = Number(result.dismissedNotificationCount) || 0;
  if (dismissed) parts.push(`dismissed ${dismissed} notification${dismissed === 1 ? '' : 's'}`);
  parts.push(...visitParts);

  const nextSessionTftReasons = new Set(
    Array.isArray(result.tftNextSessionReasons) ? result.tftNextSessionReasons : []
  );
  const liveOnlyTftReasons = Array.isArray(result.tftLiveClearReasons)
    ? result.tftLiveClearReasons.filter((reason) => !nextSessionTftReasons.has(reason))
    : [];
  if (liveOnlyTftReasons.length && !visitsSent?.tft && !deep) {
    notes.push('A rendered TFT dot still needs Deep-clean visible dots.');
  }

  if (result.uiNavigation?.requested && blockedReason) {
    notes.push(blockedPhase
      ? `Visible-dot visits were skipped — League must be fully idle (phase None; current phase: ${blockedPhase}).`
      : 'Visible-dot visits were skipped because deep-clean navigation is not currently available.');
  }

  if (!parts.length && !(result.errors || []).length && !notes.length) return 'Nothing to clean up.';

  const summary = parts.length ? `${parts.join(', ')}.` : '';
  if ((result.errors || []).length) notes.push('Some items failed; see logs.');
  return [summary || (!notes.length ? 'Cleanup could not finish.' : ''), ...notes].filter(Boolean).join(' ');
}

async function runClientCleanupOnce() {
  return runClientCleanup(false);
}

async function runClientCleanupDeepOnce() {
  return runClientCleanup(true);
}

async function runClientCleanup(deep) {
  const button = $(deep ? 'clientCleanupDeepBtn' : 'clientCleanupNowBtn');
  const otherButton = $(deep ? 'clientCleanupNowBtn' : 'clientCleanupDeepBtn');
  const idleText = deep ? 'Deep-clean visible dots' : 'Clean up now';
  button.disabled = true;
  otherButton.disabled = true;
  button.textContent = deep ? 'Deep-cleaning…' : 'Cleaning…';
  setClientCleanupHint(
    deep ? 'Checking visible client dots while League is idle…' : 'Checking the League client through its APIs…',
    { reset: false }
  );
  try {
    const result = deep
      ? await api.runClientCleanupDeepOnce()
      : await api.runClientCleanupOnce();
    setClientCleanupHint(clientCleanupResultText(result, { deep }));
  } catch (error) {
    setClientCleanupHint(`Cleanup failed: ${friendly(error)}`);
  } finally {
    button.disabled = false;
    otherButton.disabled = false;
    button.textContent = idleText;
  }
}

// Reflects the auto-accept (green on / red off) and appear-offline (green / gray) toolbar buttons.
function renderClientToggles() {
  const accept = $('autoAcceptBtn');
  const on = !!state.settings.autoAccept;
  const seconds = Math.round((state.settings.autoAcceptDelayMs ?? 0) / 1000);
  accept.textContent = on
    ? `Auto Accept On${seconds > 0 ? ` · ${seconds}s` : ''}`
    : 'Auto Accept Off';
  accept.classList.toggle('on', on);
  accept.classList.toggle('off', !on);

  const offline = $('appearOfflineBtn');
  offline.classList.toggle('offline-on', !!state.appearOffline);
  offline.title = state.appearOffline ? 'Appearing offline — click to go online' : 'Appear offline';
}

// Reflects the "Sync settings across accounts" toggle, the Update baseline button, and the hint.
function applySettingsSyncState(sync) {
  state.settingsSync = {
    on: !!sync.on,
    hasBaseline: !!sync.hasBaseline,
    capturedAt: sync.capturedAt ?? null,
    account: sync.account ?? null
  };
  $('syncSettings').checked = state.settingsSync.on;
  $('updateBaselineBtn').disabled = !state.settingsSync.on;
  const hint = $('baselineHint');
  if (state.settingsSync.on) {
    const from = state.settingsSync.account ? ` from ${state.settingsSync.account}` : '';
    const when = state.settingsSync.capturedAt ? ` · ${formatBaselineDate(state.settingsSync.capturedAt)}` : '';
    hint.textContent = `Baseline saved${from}${when}`;
  } else {
    hint.textContent = 'Applies your keybinds, camera & video settings to every account';
  }
}

function formatBaselineDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderSettingsNotice(notice = state.settingsNotice) {
  state.settingsNotice = notice;
  const banner = $('settingsNotice');
  const show = !!(state.settingsNotice && state.settingsNotice.show && state.activeTab === 'accounts');
  banner.classList.toggle('hidden', !show);
  if (show) $('settingsApplyNow').classList.toggle('hidden', !state.settingsNotice.canApply);
}

// ---------------------------------------------------------------------------
// Multi-account chat
// ---------------------------------------------------------------------------
function renderChat() {
  const conversations = Array.isArray(state.chat?.conversations) ? state.chat.conversations : [];
  const unreadCount = Math.max(0, Number(state.chat?.unreadCount) || 0);
  const tabBadge = $('chatTabBadge');
  tabBadge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
  tabBadge.classList.toggle('hidden', unreadCount === 0);
  $('chatSummary').textContent = conversations.length
    ? `${conversations.length} open · ${unreadCount ? `${unreadCount} new` : 'up to date'}`
    : 'No open chats';

  const list = $('chatConversationList');
  list.innerHTML = '';
  $('chatListEmpty').classList.toggle('hidden', conversations.length > 0);
  for (const conversation of conversations) {
    const friendPresence = chatFriendPresenceView(conversation);
    const item = el('button', `chat-conversation-item ${conversation.key === state.chat.activeKey ? 'active' : ''}`);
    item.type = 'button';
    const name = el('span', 'chat-conversation-name');
    name.appendChild(el('span', `chat-list-presence-dot presence-${friendPresence.tone}`));
    name.appendChild(el('span', 'chat-conversation-route', chatDestinationLabel(conversation)));
    item.appendChild(name);
    if (conversation.unreadCount) {
      item.appendChild(el('span', 'chat-conversation-unread', conversation.unreadCount > 99 ? '99+' : String(conversation.unreadCount)));
    }
    const meta = el('span', 'chat-conversation-meta');
    meta.appendChild(el('span', `chat-conversation-status presence-${friendPresence.tone}`, friendPresence.text));
    meta.appendChild(el('span', 'chat-conversation-source', `· via ${chatSourceLabel(conversation)}`));
    item.appendChild(meta);
    item.appendChild(el('span', 'chat-conversation-preview', chatPreview(conversation)));
    item.title = [chatRoute(conversation), friendPresence.tooltip || friendPresence.text].filter(Boolean).join('\n');
    item.addEventListener('click', () => selectChatConversation(conversation.key));
    list.appendChild(item);
  }

  const active = conversations.find((conversation) => conversation.key === state.chat.activeKey) || null;
  $('chatEmpty').classList.toggle('hidden', !!active);
  $('chatActive').classList.toggle('hidden', !active);
  if (!active) return;

  $('chatPeerName').textContent = active.destinationRiotId || active.destinationPuuid || 'Unknown friend';
  $('chatRoute').textContent = chatRoute(active);
  const friendPresence = chatFriendPresenceView(active);
  const friendPresenceTitle = friendPresence.tooltip || friendPresence.text;
  $('chatFriendPresence').textContent = friendPresence.text;
  $('chatFriendPresence').className = `chat-friend-presence presence-${friendPresence.tone}`;
  $('chatFriendPresence').title = friendPresenceTitle;
  $('chatFriendDot').className = `chat-presence-dot presence-${friendPresence.tone}`;
  $('chatFriendDot').title = friendPresenceTitle;
  $('chatPeerName').title = friendPresenceTitle;
  renderChatConnection(active);

  const messages = $('chatMessages');
  const lastMessageId = active.messages?.at(-1)?.id || '';
  const shouldScroll = messages.dataset.key !== active.key || messages.dataset.lastMessageId !== lastMessageId;
  messages.innerHTML = '';
  if (!active.messages?.length) {
    messages.appendChild(el('div', 'chat-messages-empty', 'No messages yet. Say hello.'));
  } else {
    for (const message of active.messages) {
      const row = el('div', `chat-message ${message.incoming ? 'incoming' : 'outgoing'}`);
      row.appendChild(el('div', 'chat-message-bubble', message.body));
      row.appendChild(el('span', 'chat-message-time', formatChatTime(message.receivedAt)));
      messages.appendChild(row);
    }
  }
  messages.dataset.key = active.key;
  messages.dataset.lastMessageId = lastMessageId;
  if (shouldScroll) requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });

  const input = $('chatInput');
  const preserveDraft = document.activeElement === input && input.dataset.key === active.key;
  if (!preserveDraft) input.value = active.draft || '';
  input.dataset.key = active.key;
  $('chatSend').disabled = active.connectionState === 'connecting';
}

function renderChatConnection(activeConversation = null) {
  const active = activeConversation || (state.chat?.conversations || [])
    .find((conversation) => conversation.key === state.chat.activeKey);
  if (!active) return;
  const view = chatConnectionView(active);
  const connection = $('chatConnection');
  connection.textContent = view.text;
  connection.className = `chat-connection ${view.tone}`;
}

function formatChatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

async function selectChatConversation(key) {
  try {
    state.chat = await api.selectChat(key);
    renderChat();
  } catch (error) {
    showMessage('Could not open chat', escapeHtml(friendly(error)));
  }
}

function openChatSourcePicker(friend) {
  const sources = chatSourceOptions(friend);
  if (!sources.length) {
    showMessage('Chat unavailable', 'Refresh Friends first so the app can find an account that is friends with this player.');
    return;
  }
  state.chatPickerFriend = friend;
  const name = friend.riotId || friend.gameName || 'this friend';
  $('chatSourceTitle').textContent = `Chat with ${name}`;
  $('chatSourceHint').textContent = 'Choose which of your friend accounts should be the source of this chat.';
  const choices = $('chatSourceChoices');
  choices.innerHTML = '';
  for (const source of sources) {
    const choice = el('button', 'chat-source-choice');
    choice.type = 'button';
    choice.appendChild(el('strong', '', source.label));
    choice.appendChild(el('span', '', `${source.label} → ${name}`));
    choice.addEventListener('click', () => openChatWithSource(source, choice));
    choices.appendChild(choice);
  }
  $('chatSourceOverlay').classList.remove('hidden');
}

function closeChatSourcePicker() {
  state.chatPickerFriend = null;
  $('chatSourceOverlay').classList.add('hidden');
}

async function openChatWithSource(source, button) {
  const friend = state.chatPickerFriend;
  if (!friend) return;
  button.disabled = true;
  try {
    state.chat = await api.openChat({
      sourceAccountId: source.accountId,
      friend: {
        puuid: friend.puuid,
        jid: source.jid || friend.jid || '',
        riotId: friend.riotId,
        gameName: friend.gameName,
        tagLine: friend.tagLine,
        online: !!friend.online,
        state: friend.state,
        queue: friend.queue,
        product: friend.product,
        details: friend.details,
        activity: friend.activity,
        canonicalPresence: true
      }
    });
    closeChatSourcePicker();
    setActiveTab('chat');
    renderChat();
    $('chatInput').focus();
  } catch (error) {
    button.disabled = false;
    showMessage('Could not open chat', escapeHtml(friendly(error)));
  }
}

function scheduleChatDraft() {
  const key = $('chatInput').dataset.key;
  if (!key) return;
  const draft = $('chatInput').value;
  const conversation = (state.chat?.conversations || []).find((item) => item.key === key);
  if (conversation) conversation.draft = draft;
  if (chatDraftTimer) clearTimeout(chatDraftTimer);
  chatDraftTimer = setTimeout(() => {
    chatDraftTimer = null;
    api.setChatDraft(key, draft).catch(() => {});
  }, 250);
}

async function sendActiveChat() {
  const key = state.chat?.activeKey;
  const input = $('chatInput');
  const body = input.value;
  if (!key || !body.trim()) return;
  const send = $('chatSend');
  send.disabled = true;
  try {
    if (chatDraftTimer) { clearTimeout(chatDraftTimer); chatDraftTimer = null; }
    state.chat = await api.sendChatMessage(key, body);
    // renderChat preserves a focused composer so incoming updates cannot disrupt typing. Clear the
    // value explicitly after sending, but never erase text the user entered while the send was pending.
    if (input.value === body) input.value = '';
    renderChat();
  } catch (error) {
    showMessage('Message not sent', escapeHtml(friendly(error)));
  } finally {
    send.disabled = false;
  }
}

async function closeActiveChat() {
  if (!state.chat?.activeKey) return;
  state.chat = await api.closeChat(state.chat.activeKey);
  renderChat();
}

// ---------------------------------------------------------------------------
// Status helpers (transient client-side messages during blocking calls)
// ---------------------------------------------------------------------------
function setStatusBusy(message) {
  const panel = $('statusPanel');
  if (statusDismissTimer) { clearTimeout(statusDismissTimer); statusDismissTimer = null; }
  panel.classList.remove('hidden', 'is-error', 'is-done');
  $('statusMessage').textContent = message;
  $('statusActions').innerHTML = '';
}
function clearTransientStatus() {
  if (!state.status.busy) $('statusPanel').classList.add('hidden');
  else renderStatus();
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------
let confirmResolver = null;
function confirmDialog(title, bodyHtml, okLabel = 'OK') {
  $('confirmTitle').textContent = title;
  $('confirmBody').innerHTML = bodyHtml;
  $('confirmBody').className = 'confirm-body';
  $('confirmOk').textContent = okLabel;
  $('confirmCancel').classList.remove('hidden');
  $('confirmOverlay').classList.remove('hidden');
  return new Promise((resolve) => { confirmResolver = resolve; });
}
function showMessage(title, bodyHtml) {
  $('confirmTitle').textContent = title;
  $('confirmBody').innerHTML = bodyHtml;
  $('confirmBody').className = 'confirm-body';
  $('confirmOk').textContent = 'OK';
  $('confirmCancel').classList.add('hidden');
  $('confirmOverlay').classList.remove('hidden');
  return new Promise((resolve) => { confirmResolver = resolve; });
}
function resolveConfirm(value) {
  $('confirmOverlay').classList.add('hidden');
  if (confirmResolver) { confirmResolver(value); confirmResolver = null; }
}

// Name input modal (Electron has no window.prompt). Resolves to a trimmed string, or null if cancelled.
let nameResolver = null;
function promptName(title, current = '') {
  $('nameTitle').textContent = title;
  $('nameInput').value = current;
  $('nameOverlay').classList.remove('hidden');
  $('nameInput').focus();
  $('nameInput').select();
  return new Promise((resolve) => { nameResolver = resolve; });
}
function resolveName(value) {
  $('nameOverlay').classList.add('hidden');
  if (nameResolver) { nameResolver(value); nameResolver = null; }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function setSettingsPanel(open) {
  $('settingsPanel').classList.toggle('hidden', !open);
  $('settingsToggleBtn').classList.toggle('active', open);
  localStorage.setItem('settingsPanelOpen', open ? '1' : '0');
}

function setActiveTab(tab) {
  state.activeTab = ['accounts', 'friends', 'chat'].includes(tab) ? tab : 'accounts';
  $('accountsTabPanel').classList.toggle('hidden', state.activeTab !== 'accounts');
  $('friendsTabPanel').classList.toggle('hidden', state.activeTab !== 'friends');
  $('chatTabPanel').classList.toggle('hidden', state.activeTab !== 'chat');
  $('tabAccounts').classList.toggle('active', state.activeTab === 'accounts');
  $('tabFriends').classList.toggle('active', state.activeTab === 'friends');
  $('tabChat').classList.toggle('active', state.activeTab === 'chat');
  localStorage.setItem('activeTab', state.activeTab);
  renderSettingsNotice();
  api.setChatViewActive(state.activeTab === 'chat').then((chat) => {
    if (state.activeTab === 'chat' && chat?.activeKey) return api.selectChat(chat.activeKey);
    return chat;
  }).then((chat) => {
    state.chat = chat || state.chat;
    renderChat();
  }).catch(() => {});
}

function closeMoreMenu() {
  $('moreMenu').classList.add('hidden');
}

function closeFriendsAccountMenu() {
  $('friendsPocAccountMenu').classList.add('hidden');
}

function closeFriendSourceSwitchMenu() {
  $('friendSourceSwitchMenu').classList.add('hidden');
}

function openFriendSourceSwitchMenu(sources, x, y) {
  const menu = $('friendSourceSwitchMenu');
  menu.innerHTML = '';
  for (const source of sources || []) {
    const isCurrent = source.accountId && source.accountId === state.currentClient?.accountId;
    const item = el('button', 'menu-item', isCurrent ? `${source.label} (current)` : `Switch to ${source.label}`);
    item.type = 'button';
    item.disabled = !source.accountId || isCurrent || !!state.status.busy;
    item.addEventListener('click', () => {
      closeFriendSourceSwitchMenu();
      doSwitch(source.accountId);
    });
    menu.appendChild(item);
  }
  menu.classList.remove('hidden');
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
}

async function openStatsModal() {
  try {
    state.stats = (await api.getStats()) || { accounts: [] };
  } catch (error) {
    showMessage('Could not load stats', friendly(error));
    return;
  }
  renderStatsModal();
  $('statsOverlay').classList.remove('hidden');
  $('statsClose').focus();
}

function closeStatsModal() {
  $('statsOverlay').classList.add('hidden');
}

function renderStatsModal() {
  const list = $('statsList');
  list.innerHTML = '';
  const accounts = state.stats.accounts || [];
  if (!accounts.length) {
    list.appendChild(el('p', 'empty', 'No saved accounts yet.'));
    return;
  }
  for (const account of accounts) {
    const card = el('section', 'stats-account');
    const head = el('div', 'stats-account-head');
    head.appendChild(el('span', 'stats-account-name', account.label));
    const total = el('span', 'stats-account-total', `${account.totalGames} game${account.totalGames === 1 ? '' : 's'}`);
    total.title = account.queues?.length
      ? ['Game types', ...account.queues.map((queue) => `${queue.label}: ${queue.count}`)].join('\n')
      : 'No games recorded yet';
    head.appendChild(total);
    card.appendChild(head);
    card.appendChild(el('div', 'stats-account-metrics',
      `${account.loginCount} login${account.loginCount === 1 ? '' : 's'}`));
    list.appendChild(card);
  }
}

function wireEvents() {
  $('tabAccounts').addEventListener('click', () => setActiveTab('accounts'));
  $('tabFriends').addEventListener('click', () => {
    setActiveTab('friends');
    refreshFriendsPocFromTabClick();
  });
  $('tabChat').addEventListener('click', () => setActiveTab('chat'));
  $('addBtn').addEventListener('click', () => openForm());
  $('helpBtn').addEventListener('click', () => api.openHelp());
  $('statsBtn').addEventListener('click', openStatsModal);
  $('friendsPocRefresh').addEventListener('click', refreshFriendsPoc);
  $('queueRelayStart').addEventListener('click', startQueueViaLeader);
  $('friendsPocFixFailed').addEventListener('click', fixFailedFriendSessions);
  $('friendsPocAccountsBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('friendsPocAccountMenu');
    const opening = menu.classList.contains('hidden');
    menu.classList.toggle('hidden');
    if (opening) positionFriendsAccountMenu();
  });
  $('friendsPocAccountMenu').addEventListener('click', (e) => e.stopPropagation());
  $('friendsPocSelectAll').addEventListener('change', (e) => setFriendsUseAllSources(e.target.checked));
  $('friendsPocShowOffline').addEventListener('change', (e) => {
    state.friendsPoc.showOffline = e.target.checked;
    renderFriendsPoc();
  });
  $('friendsPocShowMobile').addEventListener('change', (e) => {
    state.friendsPoc.showMobile = e.target.checked;
    renderFriendsPoc();
  });
  $('friendsPocAutoRefresh').addEventListener('change', (e) =>
    onSettingChange(
      { friendsPocAutoRefresh: e.target.checked },
      { refreshFriendsAutoRefreshIfDue: e.target.checked }
    ));
  $('friendsPocAutoRefreshSeconds').addEventListener('change', (e) => {
    const seconds = Math.min(3600, Math.max(15, Math.round(Number(e.target.value) || 60)));
    e.target.value = seconds;
    onSettingChange(
      { friendsPocAutoRefreshMs: seconds * 1000 },
      { refreshFriendsAutoRefreshIfDue: state.settings.friendsPocAutoRefresh }
    );
  });
  $('friendsPocProgressToggle').addEventListener('click', () => {
    state.friendsPoc.progressExpanded = !state.friendsPoc.progressExpanded;
    renderFriendsPocStatus();
  });

  $('settingsToggleBtn').addEventListener('click', () =>
    setSettingsPanel($('settingsPanel').classList.contains('hidden')));

  $('moreBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('moreMenu').classList.toggle('hidden');
  });
  $('moreMenu').addEventListener('click', closeMoreMenu); // any item click closes it
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.more-wrap')) closeMoreMenu();
    if (!e.target.closest('.friends-source-picker')) closeFriendsAccountMenu();
    if (!e.target.closest('#friendSourceSwitchMenu')) closeFriendSourceSwitchMenu();
  });
  window.addEventListener('resize', closeFriendSourceSwitchMenu);
  window.addEventListener('scroll', closeFriendSourceSwitchMenu, true);
  $('porofessorBtn').addEventListener('click', async () => {
    const result = await api.openPorofessor();
    if (result && result.error) showMessage('Porofessor', escapeHtml(result.error));
  });
  $('opggBtn').addEventListener('click', async () => {
    const result = await api.openOpgg();
    if (result && result.error) showMessage('OP.GG', escapeHtml(result.error));
  });
  $('githubBtn').addEventListener('click', () =>
    api.openExternal('https://github.com/Jonas-Merforth/league-account-switcher'));
  $('emptyHelp').addEventListener('click', (e) => { e.preventDefault(); api.openHelp(); });

  $('autoAcceptBtn').addEventListener('click', () => onSettingChange({ autoAccept: !state.settings.autoAccept }));
  $('appearOfflineBtn').addEventListener('click', async () => {
    const result = await api.setAppearOffline(!state.appearOffline);
    state.appearOffline = !!(result && result.on);
    renderClientToggles();
  });

  $('defaultRegion').addEventListener('change', (e) => onSettingChange({ defaultRegion: e.target.value }));
  $('startWithWindows').addEventListener('change', (e) => onSettingChange({ startWithWindows: e.target.checked }));
  $('autoUpdate').addEventListener('change', (e) => onSettingChange({ autoUpdate: e.target.checked }));
  $('autoAcceptSound').addEventListener('change', (e) =>
    onSettingChange({ autoAcceptSound: e.target.checked }));
  $('autoAcceptSoundVolume').addEventListener('input', (e) => {
    $('autoAcceptSoundVolumeValue').textContent = `${e.target.value}%`;
  });
  $('autoAcceptSoundVolume').addEventListener('change', (e) =>
    onSettingChange({ autoAcceptSoundVolume: Number(e.target.value) }));
  $('autoClientCleanup').addEventListener('change', (e) =>
    onSettingChange({ autoClientCleanup: e.target.checked }));
  $('clientCleanupNowBtn').addEventListener('click', runClientCleanupOnce);
  $('clientCleanupDeepBtn').addEventListener('click', runClientCleanupDeepOnce);
  $('friendsPocAggressiveFetching').addEventListener('change', (e) =>
    onSettingChange({ friendsPocAggressiveFetching: e.target.checked }));
  $('friendsSpectatorStats').addEventListener('change', (e) =>
    onSettingChange({ friendsSpectatorStats: e.target.checked }));
  $('chatOnlineLeaseSeconds').addEventListener('change', (e) => {
    const seconds = Math.min(3600, Math.max(15, Math.round(Number(e.target.value) || 180)));
    e.target.value = seconds;
    onSettingChange({ chatOnlineLeaseMs: seconds * 1000 });
  });
  $('autoAcceptDelay').addEventListener('change', (e) => {
    const seconds = Math.min(10, Math.max(0, Math.round(Number(e.target.value) || 0)));
    e.target.value = seconds;
    onSettingChange({ autoAcceptDelayMs: seconds * 1000 });
  });

  $('syncSettings').addEventListener('change', async (e) => {
    const result = await api.setSettingsSync(e.target.checked);
    if (result && result.error) {
      e.target.checked = false;
      applySettingsSyncState({ on: false, hasBaseline: result.hasBaseline, capturedAt: result.capturedAt });
      showMessage('Sync settings', escapeHtml(result.error));
      return;
    }
    applySettingsSyncState(result);
  });
  $('updateBaselineBtn').addEventListener('click', async () => {
    const result = await api.updateSettingsBaseline();
    if (result && result.error) { showMessage('Update baseline', escapeHtml(result.error)); return; }
    if (result && result.deferred) {
      $('baselineHint').textContent = 'Baseline update pending — saves when the game ends';
      showMessage('Update baseline', 'You’re in a game right now. Your current settings will be saved as ' +
        'the baseline automatically when the game ends.');
      return;
    }
    applySettingsSyncState({ on: true, hasBaseline: true, capturedAt: result.capturedAt, account: result.account });
    showMessage('Update baseline', 'Saved the current settings as your shared baseline.');
  });
  $('settingsApplyNow').addEventListener('click', async () => {
    renderSettingsNotice({ show: false });
    const result = await api.applySettingsNow();
    if (result && result.error) showMessage('Apply settings', escapeHtml(result.error));
  });
  $('settingsNoticeDismiss').addEventListener('click', () => {
    api.dismissSettingsNotice();
    renderSettingsNotice({ show: false });
  });
  $('checkUpdateBtn').addEventListener('click', () => {
    state.updateDismissed = false; // a manual check re-shows the banner
    api.checkForUpdate();
  });

  $('formCancel').addEventListener('click', closeForm);
  $('formSave').addEventListener('click', saveForm);
  $('formOverlay').addEventListener('click', (e) => { if (e.target === $('formOverlay')) closeForm(); });

  $('confirmOk').addEventListener('click', () => resolveConfirm(true));
  $('confirmCancel').addEventListener('click', () => resolveConfirm(false));
  $('confirmOverlay').addEventListener('click', (e) => { if (e.target === $('confirmOverlay')) resolveConfirm(false); });

  $('statsClose').addEventListener('click', closeStatsModal);
  $('statsCloseX').addEventListener('click', closeStatsModal);
  $('statsOverlay').addEventListener('click', (e) => { if (e.target === $('statsOverlay')) closeStatsModal(); });

  $('chatSourceCancel').addEventListener('click', closeChatSourcePicker);
  $('chatSourceOverlay').addEventListener('click', (e) => {
    if (e.target === $('chatSourceOverlay')) closeChatSourcePicker();
  });
  $('chatComposer').addEventListener('submit', (e) => {
    e.preventDefault();
    sendActiveChat();
  });
  $('chatInput').addEventListener('input', scheduleChatDraft);
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendActiveChat();
    }
  });
  $('chatClose').addEventListener('click', closeActiveChat);

  $('nameOk').addEventListener('click', () => resolveName($('nameInput').value.trim() || null));
  $('nameCancel').addEventListener('click', () => resolveName(null));
  $('nameOverlay').addEventListener('click', (e) => { if (e.target === $('nameOverlay')) resolveName(null); });

  document.addEventListener('keydown', (e) => {
    const nameOpen = !$('nameOverlay').classList.contains('hidden');
    const formOpen = !$('formOverlay').classList.contains('hidden');
    const chatSourceOpen = !$('chatSourceOverlay').classList.contains('hidden');
    if (e.key === 'Escape') {
      if (nameOpen) resolveName(null);
      else if (formOpen) closeForm();
      else if (chatSourceOpen) closeChatSourcePicker();
      else if (!$('confirmOverlay').classList.contains('hidden')) resolveConfirm(false);
      else if (!$('statsOverlay').classList.contains('hidden')) closeStatsModal();
      else {
        closeFriendSourceSwitchMenu();
        closeMoreMenu();
      }
    }
    if (e.key === 'Enter') {
      if (nameOpen) resolveName($('nameInput').value.trim() || null);
      else if (formOpen) saveForm();
    }
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function btn(label, className, disabled, onClick) {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.disabled = !!disabled;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
function noticeCloseBtn(onClick) {
  const b = document.createElement('button');
  b.className = 'notice-close';
  b.title = 'Dismiss';
  b.textContent = '×';
  b.addEventListener('click', onClick);
  return b;
}
function iconBtn(symbol, title, onClick) {
  const b = document.createElement('button');
  b.className = 'section-icon-btn';
  b.textContent = symbol;
  b.title = title;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}
function regionShort(code) {
  const region = state.regions.find((r) => r.code === code);
  return (region ? region.code : code).toUpperCase();
}
function setFormMsg(text, isError = false) {
  const node = $('formMsg');
  node.textContent = text || 'Password is stored encrypted (Windows DPAPI) and only used to auto-type the login if a saved session isn\'t available.';
  node.classList.toggle('error', isError);
}
function friendly(error) {
  const msg = (error && error.message) ? error.message : String(error);
  return msg.replace(/^Error:\s*/i, '').replace(/Error invoking remote method '[^']+':\s*/i, '');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();
