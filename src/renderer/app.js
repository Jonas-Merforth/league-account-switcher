import { nextUpdateView } from './updateState.js';
import { rankViews, smartFriendRankView } from './rankView.js';
import { accountSubtitle } from './accountDisplay.js';
import { friendJoinKey, friendJoinPayload, friendJoinView, shouldConfirmLobbyJoin } from './friendLobbyActions.js';
import { retryLoginTypingView } from '../core/switchRetry.js';
import { friendFavoriteKey, isFavoriteFriend, sortFriendsForFavorites } from './friendFavorites.js';
import { friendSourceSummary, friendSourceOrder } from './friendSourceView.js';
import { progressHeadline, progressMeter, updateProgressRows } from './friendProgressView.js';
import { friendPresenceTone } from './friendPresenceTone.js';
import { shouldRefreshFriendsOnTabClick } from './friendRefreshBehavior.js';

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
    autoClientCleanup: false,
    friendsPocAggressiveFetching: false,
    friendsPocUseAllAccounts: false,
    friendsPocSelectedAccountIds: [],
    friendsPocSelectionInitialized: false,
    friendsPocFavoriteFriendKeys: [],
    friendsPocAutoRefresh: false,
    friendsPocAutoRefreshMs: 60_000
  },
  status: { busy: false, stage: 'idle', message: 'Idle' },
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
    sourcesExpanded: false,
    lastRefreshAt: null,
    lastAutoRefreshAt: null
  },
  friendsPocLobby: { inLobby: false, canInvite: false, phase: null, partyId: '', localPuuid: '', memberPuuids: [] },
  currentClient: null,
  friendInviteState: {},
  friendJoinState: {},
  friendsCurrentCollapsed: false,
  activeTab: 'accounts',
  layout: { top: [], sections: [] }
};

let updateTransientTimer = null;
let statusDismissTimer = null;
let clientCleanupHintTimer = null;
let friendsAutoRefreshTimer = null;
let currentClientRefreshing = false;
let dragKind = null; // 'card' | 'section'
let dragId = null;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function init() {
  state.activeTab = localStorage.getItem('activeTab') === 'friends' ? 'friends' : 'accounts';
  state.friendsCurrentCollapsed = localStorage.getItem('friendsCurrentAccountCollapsed') === '1';
  state.regions = await api.listRegions();
  state.settings = await api.getSettings();
  state.status = await api.getStatus();

  populateRegionSelect($('defaultRegion'));
  populateRegionSelect($('fRegion'));
  $('defaultRegion').value = state.settings.defaultRegion;
  $('startWithWindows').checked = !!state.settings.startWithWindows;
  $('autoUpdate').checked = !!state.settings.autoUpdate;
  $('autoAcceptDelay').value = Math.round((state.settings.autoAcceptDelayMs ?? 2000) / 1000);
  renderClientCleanupSetting();
  $('friendsPocAggressiveFetching').checked = !!state.settings.friendsPocAggressiveFetching;
  syncFriendsAutoRefreshControls();
  state.appearOffline = !!(await api.getAppearOffline()).on;
  renderClientToggles();

  const sync = await api.getSettingsSync();
  applySettingsSyncState(sync);
  renderSettingsNotice(sync.notice);

  await reloadAccounts();
  await ensureInitialFriendsSelection();
  await Promise.all([refreshFriendsPocLobbyStatus(), refreshCurrentClientSummary()]);
  renderStatus();
  renderFriendsPoc();
  setActiveTab(state.activeTab);
  wireEvents();
  if (state.activeTab === 'friends') refreshFriendsPocFromTabClick();
  scheduleFriendsAutoRefresh();
  setSettingsPanel(localStorage.getItem('settingsPanelOpen') === '1');
  setInterval(() => {
    if (state.friendsPoc.data) renderFriendsPoc();
  }, 30_000);
  setInterval(refreshFriendsPocLobbyStatus, 5_000);
  setInterval(refreshCurrentClientSummary, 3_000);

  api.onAppearOffline((s) => {
    state.appearOffline = !!(s && s.on);
    renderClientToggles();
  });
  api.onSettingsNotice((notice) => renderSettingsNotice(notice));
  api.onFriendsPocProgress((progress) => handleFriendsPocProgress(progress));
  api.onFriendsPocRanks((update) => handleFriendsPocRanks(update));
  api.onBaselineUpdated((meta) => {
    applySettingsSyncState({ on: true, hasBaseline: true, capturedAt: meta.capturedAt, account: meta.account });
  });

  api.onStatus((status) => {
    const wasBusy = state.status.busy;
    state.status = status;
    renderStatus();
    if (wasBusy && !status.busy) {
      reloadAccounts();
      refreshCurrentClientSummary();
    }
    renderAccounts(); // refresh disabled states
    renderFriendsPoc();
  });
  api.onAccountsChanged(() => reloadAccounts());

  api.onUpdateStatus((status) => {
    state.updateStatus = status || { state: 'idle' };
    renderUpdateBanner();
  });
  state.updateStatus = (await api.getUpdateStatus()) || { state: 'idle' };
  renderUpdateBanner();
}

async function reloadAccounts() {
  state.accounts = await api.listAccounts();
  state.layout = await api.getLayout();
  renderAccounts();
  renderFriendsPoc();
}

async function refreshCurrentClientSummary() {
  if (currentClientRefreshing) return;
  currentClientRefreshing = true;
  try {
    state.currentClient = await api.getCurrentClientSummary();
  } catch (error) {
    state.currentClient = {
      kind: 'unavailable', statusLabel: 'Status unavailable',
      detail: friendly(error), tone: 'offline', accountId: null
    };
  } finally {
    currentClientRefreshing = false;
  }
  renderCurrentClientSummary();
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

async function refreshFriendsPocLobbyStatus() {
  try {
    const next = await api.getFriendsPocLobbyStatus();
    state.friendsPocLobby = {
      inLobby: !!next?.inLobby,
      canInvite: next?.canInvite !== false,
      phase: next?.phase || null,
      partyId: next?.partyId || '',
      localPuuid: next?.localPuuid || '',
      memberPuuids: Array.isArray(next?.memberPuuids) ? next.memberPuuids : [],
      memberCount: Number(next?.memberCount || 0),
      partyType: next?.partyType || '',
      reason: next?.reason || ''
    };
  } catch {
    state.friendsPocLobby = { inLobby: false, canInvite: false, phase: null, partyId: '', localPuuid: '', memberPuuids: [] };
  }
  renderFriendsPoc();
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
  const puuid = String(friend?.puuid || '').toLowerCase();
  const local = String(state.friendsPocLobby.localPuuid || '').toLowerCase();
  return !!(puuid && local && puuid === local);
}

function canShowFriendInvite(friend) {
  if (!state.friendsPocLobby.inLobby || !state.friendsPocLobby.canInvite) return false;
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

  $('friendsPocRefresh').disabled = state.friendsPoc.loading || selectedIds.length === 0;
}

function renderFriendsTabBadge() {
  const badge = $('friendsTabBadge');
  const data = state.friendsPoc.data;
  badge.classList.toggle('hidden', !data);
  if (data) {
    // The badge counts who you'd actually see: online friends, minus mobile-only ones (hidden by default).
    const mobileOnline = state.friendsPoc.showMobile
      ? 0
      : data.merged.filter((friend) => friend.online && isMobileFriend(friend)).length;
    badge.textContent = String(Math.max(0, (data.onlineCount || 0) - mobileOnline));
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
  const hasLiveAccount = !['closed', 'signed-out', 'loading', 'unavailable'].includes(view.kind);
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

function handleFriendsPocProgress(progress) {
  if (!progress || typeof progress !== 'object') return;
  state.friendsPoc.progressRows = updateProgressRows(state.friendsPoc.progressRows || [], progress);
  state.friendsPoc.progress = progress;
  renderFriendsPoc();
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

function renderFriendsPocProgress() {
  const wrap = $('friendsPocProgress');
  const progress = state.friendsPoc.progress;
  const show = !!(state.friendsPoc.loading && progress);
  wrap.classList.toggle('hidden', !show);
  if (!show) return;

  const meter = progressMeter(progress, selectedFriendSourceIds().length);
  $('friendsPocProgressText').textContent = progressHeadline(progress);
  $('friendsPocProgressCount').textContent = meter.total ? `${meter.done}/${meter.total} done` : '';
  $('friendsPocProgressFill').style.width = `${meter.percent}%`;

  const toggle = $('friendsPocProgressToggle');
  const hasRows = (state.friendsPoc.progressRows || []).length > 0;
  toggle.classList.toggle('hidden', !hasRows);
  toggle.textContent = state.friendsPoc.progressExpanded ? 'Hide details' : 'Details';

  const log = $('friendsPocProgressLog');
  log.classList.toggle('hidden', !state.friendsPoc.progressExpanded || !hasRows);
  log.innerHTML = '';
  if (!state.friendsPoc.progressExpanded) return;
  for (const row of state.friendsPoc.progressRows || []) {
    const line = el('div', `friends-progress-line ${row.status}`);
    line.appendChild(el('span', 'friends-progress-account', row.label));
    line.appendChild(el('span', 'friends-progress-message', row.error || row.message));
    log.appendChild(line);
  }
}

function failedFriendSources() {
  return state.friendsPoc.data?.errors || [];
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
  button.disabled = state.friendsPoc.loading || state.status.busy;
  button.textContent = failed.length === 1 ? 'Fix failed session' : `Fix ${failed.length} failed sessions`;
}

function renderFriendsPoc() {
  const status = $('friendsPocStatus');
  const accounts = $('friendsPocAccounts');
  const list = $('friendsPocList');
  accounts.innerHTML = '';
  list.innerHTML = '';
  status.classList.remove('error', 'hidden');
  $('friendsPocShowOffline').checked = !!state.friendsPoc.showOffline;
  $('friendsPocShowMobile').checked = !!state.friendsPoc.showMobile;
  renderFriendsPocSources();
  renderFriendsTabBadge();
  renderFriendsPocMeta();
  renderCurrentClientSummary();
  renderFriendsPocProgress();
  renderFailedSessionAction();

  const data = state.friendsPoc.data;
  if (state.friendsPoc.loading) {
    // The progress box below already headlines the in-flight refresh (with a per-source
    // count and bar), so only show this line as a fallback until the first progress event
    // lands — otherwise the same "Refreshing…" message appears twice, stacked.
    if (state.friendsPoc.progress) {
      status.textContent = '';
      status.classList.add('hidden');
    } else {
      status.textContent = `Refreshing ${selectedFriendSourceIds().length} saved-session friend list(s)...`;
    }
  } else if (state.friendsPoc.error) {
    status.textContent = state.friendsPoc.error;
    status.classList.add('error');
  } else if (!data) {
    status.textContent = selectedFriendSourceIds().length
      ? 'Not refreshed yet.'
      : 'Select at least one saved-session source, then refresh.';
  }

  if (!data) return;

  const showMobile = !!state.friendsPoc.showMobile;
  if (!state.friendsPoc.loading && !state.friendsPoc.error) {
    const offlineHidden = state.friendsPoc.showOffline ? 0 : (data.offlineCount || 0);
    const mobileHidden = showMobile ? 0 : data.merged.filter((friend) => friend.online && isMobileFriend(friend)).length;
    const failed = data.errors?.length || 0;
    status.textContent = `${data.merged.length} friends from ${data.accounts.length} source${data.accounts.length === 1 ? '' : 's'}` +
      ` — ${data.onlineCount || 0} online${mobileHidden ? `, ${mobileHidden} on mobile hidden` : ''}` +
      `${offlineHidden ? `, ${offlineHidden} offline hidden` : ''}${failed ? `, ${failed} failed` : ''}.`;
    status.classList.toggle('error', failed > 0);
  }

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
    ? data.merged
    : data.merged.filter((friend) => friend.online);
  // By default, drop friends who are only on the Riot mobile app so the list is just who's in the
  // League client; "Show mobile" brings them back. Mobile friends are online, so this also trims them
  // from the Show-offline view unless Show mobile is on.
  if (!showMobile) visibleFriends = visibleFriends.filter((friend) => !isMobileFriend(friend));
  visibleFriends = sortFriendsForFavorites(visibleFriends, state.settings.friendsPocFavoriteFriendKeys);

  if (!visibleFriends.length) {
    const empty = el('div', 'friend-empty', data.merged.length
      ? 'No friends to show. Try turning on Show mobile or Show offline.'
      : 'No friends found in these saved sessions.');
    list.appendChild(empty);
    return;
  }

  for (const friend of visibleFriends) {
    const tone = friendPresenceTone(friend);
    const row = el('div', `friend-row ${friend.online ? 'online' : 'offline'} presence-${tone}`);
    const main = el('div', 'friend-main');
    const title = el('span', 'friend-title');
    title.appendChild(renderFriendFavoriteButton(friend));
    title.appendChild(el('span', `friend-online-dot ${friend.online ? 'on' : ''} presence-${tone}`));
    title.appendChild(el('span', 'friend-name', friend.riotId || 'Unknown friend'));
    main.appendChild(title);
    const stateLine = el('span', `friend-state presence-${tone}`, friendStateText(friend));
    const activityTip = friendActivityTooltip(friend);
    if (activityTip) {
      stateLine.title = activityTip;
      row.title = activityTip;
    }
    main.appendChild(stateLine);
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
    sources.title = `Friends with: ${seen.join(', ')}`;
    const playingWith = playingWithFriends(friend);
    if (playingWith.length) {
      const label = playingWith.length === 1 ? 'With 1 friend' : `With ${playingWith.length} friends`;
      const badge = el('span', 'friend-source-badge playing-with', label);
      badge.title = `Playing with: ${playingWith.join(', ')}`;
      sources.appendChild(badge);
    }
    // Show the source account names, but keep the row readable: with 3+ sources, show just the first
    // and roll the rest into a "+N" pill (full list is on hover) so the friend's name never gets squeezed.
    const shown = seen.length <= 2 ? seen.length : 1;
    for (const source of seen.slice(0, shown)) {
      sources.appendChild(el('span', 'friend-source-badge', source));
    }
    if (seen.length > shown) {
      const hidden = seen.slice(shown);
      const more = el('span', 'friend-source-badge more', `+${hidden.length}`);
      more.title = hidden.join(', '); // hovering the "+N" pill names the accounts it stands in for
      sources.appendChild(more);
    }
    side.appendChild(sources);
    const joinButton = renderFriendJoinButton(friend);
    if (joinButton) side.appendChild(joinButton);
    const inviteButton = renderFriendInviteButton(friend);
    if (inviteButton) side.appendChild(inviteButton);
    row.appendChild(side);
    list.appendChild(row);
  }
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
  chip.appendChild(el('span', 'friend-source-count', 'failed'));
  chip.title = failure.error || failure.label;
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
  const view = friendJoinView(friend, state.friendsPocLobby, state.friendJoinState);
  if (!view.visible) return null;
  const button = btn(view.label, `btn small friend-action-btn friend-join-btn ${view.status}`, view.disabled, (event) => {
    event.stopPropagation();
    joinFriendLobbyFromRow(friend);
  });
  button.title = view.title || 'Join lobby';
  return button;
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
  button.title = invite.title || `Invite ${friend.riotId || friend.gameName || 'friend'} to current lobby`;
  return button;
}

const FRIEND_STATE_LABELS = {
  chat: 'Online',
  online: 'Online',
  away: 'Away',
  mobile: 'On mobile',
  dnd: 'In game'
};

// A friend on the Riot mobile app (not in the League client) — its presence state is "mobile".
function isMobileFriend(friend) {
  return String(friend.state || '').toLowerCase() === 'mobile';
}

function friendStateText(friend) {
  const activity = friend.activity;
  if (activity) {
    if (activity.kind === 'inGame') {
      return ['In game', activity.queueLabel, activity.championName, friendActivityDuration(activity)]
        .filter(Boolean)
        .join(' · ');
    }
    if (activity.kind === 'lobby') {
      const size = partySizeText(activity.party);
      const queue = activity.queueLabel || 'Game';
      return `${size ? `${size} ` : ''}${queue} lobby`;
    }
    if (activity.kind === 'champSelect') {
      return ['Champ select', activity.queueLabel].filter(Boolean).join(' · ');
    }
    if (activity.kind === 'queue') {
      return ['In queue', activity.queueLabel].filter(Boolean).join(' · ');
    }
    if (activity.kind === 'postGame') {
      return ['Post-match screen', activity.queueLabel].filter(Boolean).join(' · ');
    }
    if (activity.label) return activity.label;
  }
  if (!friend.online) return 'Offline';
  const key = String(friend.state || '').toLowerCase();
  const base = FRIEND_STATE_LABELS[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Online');
  // A queue only makes sense for the "in game / in queue" states; don't tack it onto a plain "Online".
  const queue = friend.queue && key === 'dnd' ? ` · ${friend.queue}` : '';
  return `${base}${queue}`;
}

function friendActivityTooltip(friend) {
  const activity = friend.activity;
  if (!activity || !['inGame', 'lobby', 'champSelect', 'queue', 'postGame'].includes(activity.kind)) return '';
  const lines = [activity.label || friendStateText(friend)];
  if (activity.kind === 'lobby') {
    const size = partySizeText(activity.party);
    const queue = activity.queueLabel || 'Game';
    lines.push(`Lobby: ${size ? `${size} ` : ''}${queue}`);
  } else if (activity.queueLabel) {
    lines.push(`Game: ${activity.queueLabel}`);
  }
  if (activity.championName) lines.push(`Champion: ${activity.championName}`);
  const duration = friendActivityDuration(activity);
  if (duration) lines.push(`Duration: ${duration}`);
  const party = partyMembersText(activity.party);
  if (party) lines.push(`Party: ${party}`);
  if (activity.spectatable) lines.push('Spectatable');
  if (activity.gameStatus) lines.push(`Status: ${activity.gameStatus}`);
  return lines.join('\n');
}

function playingWithFriends(friend) {
  return [...(friend.activity?.party?.playingWithNames || [])];
}

function partySizeText(party) {
  if (!party) return '';
  if (party.size && party.maxSize) return `${party.size}/${party.maxSize}`;
  if (party.size) return String(party.size);
  return '';
}

function partyMembersText(party) {
  if (!party) return '';
  const names = [...(party.playingWithNames || party.memberNames || [])];
  if (party.unknownCount) names.push(`${party.unknownCount} unknown`);
  return names.join(', ');
}

function friendActivityDuration(activity) {
  const started = Date.parse(activity?.startedAt || '');
  if (!Number.isFinite(started)) return '';
  const totalMinutes = Math.max(0, Math.floor((Date.now() - started) / 60_000));
  if (totalMinutes < 1) return 'just started';
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
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
  renderFriendsPoc();
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
  if (shouldConfirmLobbyJoin(payload, state.friendsPocLobby)) {
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
    await refreshFriendsPocLobbyStatus();
    renderFriendsPoc();
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
    await refreshFriendsPocLobbyStatus();
    renderFriendsPoc();
  }
}

async function waitForSwitchToFinish(label) {
  for (;;) {
    const status = await api.getStatus();
    state.status = status;
    renderStatus();
    renderAccounts();
    renderFriendsPoc();
    if (!status.busy) {
      if (status.stage === 'error') throw new Error(status.message || `Switch to ${label} failed.`);
      return status;
    }
    await delay(1_000);
  }
}

async function fixFailedFriendSessions() {
  const failed = failedFriendSources();
  if (!failed.length) return;
  const ok = await confirmDialog(
    'Fix failed sessions',
    `These accounts can't fetch friends because their saved session wasn't stored with <b>"Stay signed in"</b>, ` +
      `so Riot refuses to replay it. ` +
      `Re-login ${failed.length} account${failed.length === 1 ? '' : 's'} now? ` +
      `For each one, the app closes the Riot Client, clears the old session, and auto-types the login with ` +
      `<b>"Stay signed in"</b> checked. It tries each login in the background first; Riot is only brought forward if that fails. ` +
      `After that the saved session fetches normally.`,
    'Re-login'
  );
  if (!ok) return;

  const fixed = [];
  const stillFailed = [];
  try {
    for (const [index, failure] of failed.entries()) {
      try {
        setStatusBusy(`Re-login ${index + 1}/${failed.length}: ${failure.label} — signing in...`);
        await api.reloginAccount(failure.accountId);
        await waitForSwitchToFinish(failure.label);
        fixed.push(failure.label);
      } catch (error) {
        stillFailed.push({ label: failure.label, error: friendly(error) });
      }
    }
    clearTransientStatus();
    await reloadAccounts();
    if (fixed.length) await refreshFriendsPoc();
    if (stillFailed.length) {
      const fixedText = fixed.length ? `Re-logged in: <b>${escapeHtml(fixed.join(', '))}</b>.<br><br>` : '';
      const failedText = stillFailed
        .map((item) => `<b>${escapeHtml(item.label)}</b>: ${escapeHtml(item.error)}`)
        .join('<br>');
      showMessage('Fix failed sessions', `${fixedText}Still failed:<br>${failedText}`);
    } else {
      showMessage('Fix failed sessions', `Re-logged in: <b>${escapeHtml(fixed.join(', '))}</b>.<br><br>The friendlist has been refreshed.`);
    }
  } catch (error) {
    clearTransientStatus();
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
  const last = lastFriendsRefreshAt();
  if (!last) return 0;
  const elapsed = Math.max(0, Date.now() - last);
  return Math.max(0, friendsAutoRefreshMs() - elapsed);
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
  renderClientCleanupSetting();
  $('friendsPocAggressiveFetching').checked = !!state.settings.friendsPocAggressiveFetching;
  syncFriendsAutoRefreshControls();
  scheduleFriendsAutoRefresh({ refreshIfDue: !!options.refreshFriendsAutoRefreshIfDue });
  renderClientToggles();
  renderUpdateBanner(); // autoUpdate affects banner text/actions
  renderFriendsPoc();
}

const CLIENT_CLEANUP_DEFAULT_HINT = 'Claims Season/Mayhem rewards and clears client dots and home notices';

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

function clientCleanupResultText(result) {
  if (!result || result.status === 'unavailable') return 'League client is not ready.';
  if (result.status === 'blocked') return 'Paused during ready check, champ select, and games — try again afterwards.';

  const parts = [];
  const count = Number(result.claimedRewardCount) || 0;
  if (count) parts.push(`Claimed ${count} pass reward${count === 1 ? '' : 's'}`);
  if (result.cleared?.home) parts.push('cleared the League home notices');
  if (result.cleared?.collection) parts.push('cleared the Collection dot');
  if (result.cleared?.tft) parts.push('cleared the TFT notice');
  if (result.cleared?.profile) parts.push('cleared the profile dot');
  const dismissed = Number(result.dismissedNotificationCount) || 0;
  if (dismissed) parts.push(`dismissed ${dismissed} notification${dismissed === 1 ? '' : 's'}`);
  if (!parts.length && !(result.errors || []).length) return 'Nothing to clean up.';

  const summary = parts.length ? `${parts.join(', ')}.` : 'Cleanup could not finish.';
  return (result.errors || []).length ? `${summary} Some items failed; see logs.` : summary;
}

async function runClientCleanupOnce() {
  const button = $('clientCleanupNowBtn');
  button.disabled = true;
  button.textContent = 'Cleaning…';
  setClientCleanupHint('Checking the League client…', { reset: false });
  try {
    const result = await api.runClientCleanupOnce();
    setClientCleanupHint(clientCleanupResultText(result));
  } catch (error) {
    setClientCleanupHint(`Cleanup failed: ${friendly(error)}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Clean up now';
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
  state.activeTab = tab === 'friends' ? 'friends' : 'accounts';
  $('accountsTabPanel').classList.toggle('hidden', state.activeTab !== 'accounts');
  $('friendsTabPanel').classList.toggle('hidden', state.activeTab !== 'friends');
  $('tabAccounts').classList.toggle('active', state.activeTab === 'accounts');
  $('tabFriends').classList.toggle('active', state.activeTab === 'friends');
  localStorage.setItem('activeTab', state.activeTab);
  renderSettingsNotice();
}

function closeMoreMenu() {
  $('moreMenu').classList.add('hidden');
}

function closeFriendsAccountMenu() {
  $('friendsPocAccountMenu').classList.add('hidden');
}

function wireEvents() {
  $('tabAccounts').addEventListener('click', () => setActiveTab('accounts'));
  $('tabFriends').addEventListener('click', () => {
    setActiveTab('friends');
    refreshFriendsPocFromTabClick();
  });
  $('addBtn').addEventListener('click', () => openForm());
  $('helpBtn').addEventListener('click', () => api.openHelp());
  $('friendsPocRefresh').addEventListener('click', refreshFriendsPoc);
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
    onSettingChange({ friendsPocAutoRefreshMs: seconds * 1000 });
  });
  $('friendsPocProgressToggle').addEventListener('click', () => {
    state.friendsPoc.progressExpanded = !state.friendsPoc.progressExpanded;
    renderFriendsPocProgress();
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
  });
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
  $('autoClientCleanup').addEventListener('change', (e) =>
    onSettingChange({ autoClientCleanup: e.target.checked }));
  $('clientCleanupNowBtn').addEventListener('click', runClientCleanupOnce);
  $('friendsPocAggressiveFetching').addEventListener('change', (e) =>
    onSettingChange({ friendsPocAggressiveFetching: e.target.checked }));
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

  $('nameOk').addEventListener('click', () => resolveName($('nameInput').value.trim() || null));
  $('nameCancel').addEventListener('click', () => resolveName(null));
  $('nameOverlay').addEventListener('click', (e) => { if (e.target === $('nameOverlay')) resolveName(null); });

  document.addEventListener('keydown', (e) => {
    const nameOpen = !$('nameOverlay').classList.contains('hidden');
    const formOpen = !$('formOverlay').classList.contains('hidden');
    if (e.key === 'Escape') {
      if (nameOpen) resolveName(null);
      else if (formOpen) closeForm();
      else if (!$('confirmOverlay').classList.contains('hidden')) resolveConfirm(false);
      else closeMoreMenu();
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
