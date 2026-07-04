import { nextUpdateView } from './updateState.js';
import { rankViews } from './rankView.js';
import { accountSubtitle } from './accountDisplay.js';

const api = window.api;
const $ = (id) => document.getElementById(id);
const FRIENDS_FIX_CAPTURE_SETTLE_MS = 25_000;
const FRIENDS_FIX_VALIDATE_ATTEMPTS = 3;
const FRIENDS_FIX_VALIDATE_RETRY_MS = 3_000;

const state = {
  accounts: [],
  regions: [],
  settings: {
    defaultRegion: 'euw',
    startWithWindows: true,
    autoUpdate: true,
    autoAccept: false,
    autoAcceptDelayMs: 2000,
    friendsPocAggressiveFetching: false,
    friendsPocUseAllAccounts: false,
    friendsPocSelectedAccountIds: [],
    friendsPocSelectionInitialized: false
  },
  status: { busy: false, stage: 'idle', message: 'Idle' },
  editingId: null,
  updateStatus: { state: 'idle' },
  updateDismissed: false,
  appearOffline: false,
  settingsSync: { on: false, hasBaseline: false, capturedAt: null, account: null },
  settingsNotice: null,
  friendsPoc: { loading: false, data: null, error: null, showOffline: false, progress: null, progressLines: [] },
  activeTab: 'accounts',
  layout: { top: [], sections: [] }
};

let updateTransientTimer = null;
let statusDismissTimer = null;
let dragKind = null; // 'card' | 'section'
let dragId = null;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function init() {
  state.activeTab = localStorage.getItem('activeTab') === 'friends' ? 'friends' : 'accounts';
  state.regions = await api.listRegions();
  state.settings = await api.getSettings();
  state.status = await api.getStatus();

  populateRegionSelect($('defaultRegion'));
  populateRegionSelect($('fRegion'));
  $('defaultRegion').value = state.settings.defaultRegion;
  $('startWithWindows').checked = !!state.settings.startWithWindows;
  $('autoUpdate').checked = !!state.settings.autoUpdate;
  $('autoAcceptDelay').value = Math.round((state.settings.autoAcceptDelayMs ?? 2000) / 1000);
  $('friendsPocAggressiveFetching').checked = !!state.settings.friendsPocAggressiveFetching;
  state.appearOffline = !!(await api.getAppearOffline()).on;
  renderClientToggles();

  const sync = await api.getSettingsSync();
  applySettingsSyncState(sync);
  renderSettingsNotice(sync.notice);

  await reloadAccounts();
  await ensureInitialFriendsSelection();
  renderStatus();
  renderFriendsPoc();
  setActiveTab(state.activeTab);
  wireEvents();
  setSettingsPanel(localStorage.getItem('settingsPanelOpen') === '1');
  setInterval(() => {
    if (state.friendsPoc.data) renderFriendsPoc();
  }, 30_000);

  api.onAppearOffline((s) => {
    state.appearOffline = !!(s && s.on);
    renderClientToggles();
  });
  api.onSettingsNotice((notice) => renderSettingsNotice(notice));
  api.onFriendsPocProgress((progress) => handleFriendsPocProgress(progress));
  api.onBaselineUpdated((meta) => {
    applySettingsSyncState({ on: true, hasBaseline: true, capturedAt: meta.capturedAt, account: meta.account });
  });

  api.onStatus((status) => {
    const wasBusy = state.status.busy;
    state.status = status;
    renderStatus();
    if (wasBusy && !status.busy) reloadAccounts();
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
  if (data) badge.textContent = String(data.onlineCount || 0);
}

function renderFriendsPocMeta() {
  const data = state.friendsPoc.data;
  const selectedCount = selectedFriendSourceIds().length;
  const savedCount = savedFriendSourceAccounts().length;
  const mode = state.settings.friendsPocAggressiveFetching ? 'Aggressive parallel' : 'Careful sequential';
  const last = data && data.refreshedAt ? `${relativeAge(data.refreshedAt)} (${formatTime(data.refreshedAt)})` : 'never';
  const parts = [
    'Manual refresh only',
    mode,
    `${selectedCount}/${savedCount} sources`,
    `Last fetch: ${last}`
  ];
  if (data && Number.isFinite(data.elapsedMs)) parts.push(`Took ${formatDuration(data.elapsedMs)}`);
  if (data && Number.isFinite(data.presenceWaitMs)) parts.push(`Presence wait ${formatDuration(data.presenceWaitMs)}`);
  $('friendsPocMeta').textContent = parts.join(' | ');
}

function handleFriendsPocProgress(progress) {
  if (!progress || typeof progress !== 'object') return;
  const phase = String(progress.phase || '');
  if (phase === 'refresh-start') {
    state.friendsPoc.progressLines = [];
  }
  state.friendsPoc.progress = progress;
  if (progress.message) {
    const lines = state.friendsPoc.progressLines || [];
    if (lines[lines.length - 1] !== progress.message) {
      lines.push(progress.message);
      state.friendsPoc.progressLines = lines.slice(-6);
    }
  }
  renderFriendsPoc();
}

function renderFriendsPocProgress() {
  const wrap = $('friendsPocProgress');
  const progress = state.friendsPoc.progress;
  const show = !!(state.friendsPoc.loading && progress);
  wrap.classList.toggle('hidden', !show);
  if (!show) return;

  const total = Number(progress.accountTotal || selectedFriendSourceIds().length || 0);
  const done = Math.min(total, Math.max(0, Number(progress.accountDone || 0)));
  const percent = total ? Math.round((done / total) * 100) : 0;
  $('friendsPocProgressText').textContent = progress.message || 'Refreshing saved-session friend lists...';
  $('friendsPocProgressCount').textContent = total ? `${done}/${total} done` : '';
  $('friendsPocProgressFill').style.width = `${percent}%`;

  const log = $('friendsPocProgressLog');
  log.innerHTML = '';
  for (const line of state.friendsPoc.progressLines || []) {
    log.appendChild(el('div', 'friends-progress-line', line));
  }
}

function failedFriendSources() {
  return state.friendsPoc.data?.errors || [];
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
  status.classList.remove('error');
  $('friendsPocShowOffline').checked = !!state.friendsPoc.showOffline;
  renderFriendsPocSources();
  renderFriendsTabBadge();
  renderFriendsPocMeta();
  renderFriendsPocProgress();
  renderFailedSessionAction();

  const data = state.friendsPoc.data;
  if (state.friendsPoc.loading) {
    status.textContent = `Refreshing ${selectedFriendSourceIds().length} saved-session friend list(s)...`;
  } else if (state.friendsPoc.error) {
    status.textContent = state.friendsPoc.error;
    status.classList.add('error');
  } else if (!data) {
    status.textContent = selectedFriendSourceIds().length
      ? 'Not refreshed yet.'
      : 'Select at least one saved-session source, then refresh.';
  }

  if (!data) return;

  if (!state.friendsPoc.loading && !state.friendsPoc.error) {
    const hidden = state.friendsPoc.showOffline ? 0 : (data.offlineCount || 0);
    const failed = data.errors?.length || 0;
    status.textContent = `Fetched ${data.merged.length} merged friends from ${data.accounts.length} saved sessions` +
      ` (${data.onlineCount || 0} online${hidden ? `, ${hidden} hidden offline` : ''}${failed ? `, ${failed} failed` : ''}).`;
    status.classList.toggle('error', failed > 0);
  }

  for (const account of data.accounts) {
    const chip = el('div', 'friend-source');
    chip.appendChild(el('span', 'friend-source-name', account.label));
    chip.appendChild(el('span', 'friend-source-count', `${account.onlineCount || 0}/${account.friends.length} online`));
    chip.title = account.riotId || account.label;
    accounts.appendChild(chip);
  }
  for (const failure of data.errors || []) {
    const chip = el('div', 'friend-source failed');
    chip.appendChild(el('span', 'friend-source-name', failure.label));
    chip.appendChild(el('span', 'friend-source-count', 'failed'));
    chip.title = failure.error || failure.label;
    accounts.appendChild(chip);
  }

  const visibleFriends = state.friendsPoc.showOffline
    ? data.merged
    : data.merged.filter((friend) => friend.online);

  if (!visibleFriends.length) {
    const empty = el('div', 'friend-empty', data.merged.length
      ? 'No online friends found. Enable Show offline to see the full roster.'
      : 'No friends found in these saved sessions.');
    list.appendChild(empty);
    return;
  }

  for (const friend of visibleFriends) {
    const row = el('div', `friend-row ${friend.online ? 'online' : 'offline'}`);
    const main = el('div', 'friend-main');
    const title = el('span', 'friend-title');
    title.appendChild(el('span', `friend-online-dot ${friend.online ? 'on' : ''}`));
    title.appendChild(el('span', 'friend-name', friend.riotId || 'Unknown friend'));
    main.appendChild(title);
    main.appendChild(el('span', 'friend-state', friendStateText(friend)));
    row.appendChild(main);

    const sources = el('div', 'friend-sources');
    for (const source of friend.seenFrom || []) {
      sources.appendChild(el('span', 'friend-source-badge', source));
    }
    row.appendChild(sources);
    list.appendChild(row);
  }
}

function friendStateText(friend) {
  if (!friend.online) return 'Offline';
  const state = friend.state && friend.state !== 'online' ? friend.state : 'Online';
  const queue = friend.queue ? ` · ${friend.queue}` : '';
  return `${state}${queue}`;
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

async function refreshFriendsPoc() {
  const accountIds = selectedFriendSourceIds();
  if (!accountIds.length) {
    state.friendsPoc = { ...state.friendsPoc, loading: false, error: 'Select at least one saved-session source first.' };
    renderFriendsPoc();
    return;
  }
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
    progressLines: []
  };
  $('friendsPocRefresh').disabled = true;
  renderFriendsPoc();
  try {
    const data = await api.refreshFriendsPoc({ accountIds });
    state.friendsPoc = { ...state.friendsPoc, loading: false, data, error: null, progress: null };
  } catch (error) {
    state.friendsPoc = { ...state.friendsPoc, loading: false, error: friendly(error), progress: null };
  } finally {
    $('friendsPocRefresh').disabled = false;
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

async function waitWithCountdown(totalMs, messageForRemainingMs) {
  const deadline = Date.now() + totalMs;
  for (;;) {
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs <= 0) return;
    setStatusBusy(messageForRemainingMs(remainingMs));
    await delay(Math.min(1_000, remainingMs));
  }
}

async function validateFixedFriendSession(failure, index, total) {
  let lastError = null;
  for (let attempt = 1; attempt <= FRIENDS_FIX_VALIDATE_ATTEMPTS; attempt += 1) {
    setStatusBusy(`Validating friend auth ${index}/${total}: ${failure.label} (attempt ${attempt}/${FRIENDS_FIX_VALIDATE_ATTEMPTS})...`);
    try {
      return await api.validateFriendsPocSession(failure.accountId);
    } catch (error) {
      lastError = error;
      if (attempt < FRIENDS_FIX_VALIDATE_ATTEMPTS) {
        await waitWithCountdown(FRIENDS_FIX_VALIDATE_RETRY_MS, (remainingMs) =>
          `Friend auth still rejected ${failure.label}; retrying in ${Math.ceil(remainingMs / 1000)}s...`);
      }
    }
  }
  throw new Error(`Captured session for ${failure.label}, but Friends auth still rejects it: ${friendly(lastError)}`);
}

async function fixFailedFriendSessions() {
  const failed = failedFriendSources();
  if (!failed.length) return;
  const ok = await confirmDialog(
    'Fix failed sessions',
    `Switch through ${failed.length} failed account${failed.length === 1 ? '' : 's'} now? ` +
      `The app will sign in, wait ${formatDuration(FRIENDS_FIX_CAPTURE_SETTLE_MS)} for Riot's saved session to settle, ` +
      'then close the Riot Client and validate the session for Friends auth. ' +
      'If Riot requires interactive auth or 2FA for an account, it may still fail.',
    'Start'
  );
  if (!ok) return;

  const fixed = [];
  const stillFailed = [];
  try {
    for (const [index, failure] of failed.entries()) {
      try {
        setStatusBusy(`Fixing session ${index + 1}/${failed.length}: ${failure.label}...`);
        await api.switchAccount(failure.accountId, false);
        await waitForSwitchToFinish(failure.label);
        await waitWithCountdown(FRIENDS_FIX_CAPTURE_SETTLE_MS, (remainingMs) =>
          `Waiting for Riot session to settle ${index + 1}/${failed.length}: ${failure.label} (${Math.ceil(remainingMs / 1000)}s)...`);
        setStatusBusy(`Capturing fresh session ${index + 1}/${failed.length}: ${failure.label}...`);
        const capture = await api.captureAccount(failure.accountId, false);
        if (capture && capture.persisted === false) {
          throw new Error(capture.warning || `Could not capture a fresh session for ${failure.label}.`);
        }
        await validateFixedFriendSession(failure, index + 1, failed.length);
        fixed.push(failure.label);
      } catch (error) {
        stillFailed.push({ label: failure.label, error: friendly(error) });
      }
    }
    clearTransientStatus();
    await reloadAccounts();
    if (stillFailed.length) {
      const fixedText = fixed.length ? `Fixed and validated: <b>${escapeHtml(fixed.join(', '))}</b>.<br><br>` : '';
      const failedText = stillFailed
        .map((item) => `<b>${escapeHtml(item.label)}</b>: ${escapeHtml(item.error)}`)
        .join('<br>');
      showMessage('Fix failed sessions', `${fixedText}Still failed:<br>${failedText}`);
    } else {
      showMessage('Fix failed sessions', 'Finished switching, capturing, and validating fresh sessions. Refresh the friendlist again.');
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
async function onSettingChange(patch) {
  state.settings = await api.setSettings(patch);
  $('defaultRegion').value = state.settings.defaultRegion;
  $('startWithWindows').checked = !!state.settings.startWithWindows;
  $('autoUpdate').checked = !!state.settings.autoUpdate;
  $('autoAcceptDelay').value = Math.round((state.settings.autoAcceptDelayMs ?? 2000) / 1000);
  $('friendsPocAggressiveFetching').checked = !!state.settings.friendsPocAggressiveFetching;
  renderClientToggles();
  renderUpdateBanner(); // autoUpdate affects banner text/actions
  renderFriendsPoc();
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
  $('tabFriends').addEventListener('click', () => setActiveTab('friends'));
  $('addBtn').addEventListener('click', () => openForm());
  $('helpBtn').addEventListener('click', () => api.openHelp());
  $('friendsPocRefresh').addEventListener('click', refreshFriendsPoc);
  $('friendsPocFixFailed').addEventListener('click', fixFailedFriendSessions);
  $('friendsPocAccountsBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('friendsPocAccountMenu').classList.toggle('hidden');
  });
  $('friendsPocAccountMenu').addEventListener('click', (e) => e.stopPropagation());
  $('friendsPocSelectAll').addEventListener('change', (e) => setFriendsUseAllSources(e.target.checked));
  $('friendsPocShowOffline').addEventListener('change', (e) => {
    state.friendsPoc.showOffline = e.target.checked;
    renderFriendsPoc();
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
