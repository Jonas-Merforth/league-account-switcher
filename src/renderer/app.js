import { nextUpdateView } from './updateState.js';

const api = window.api;
const $ = (id) => document.getElementById(id);

const state = {
  accounts: [],
  regions: [],
  settings: { defaultRegion: 'euw', startWithWindows: true, autoUpdate: true, autoAccept: false, autoAcceptDelayMs: 2000 },
  status: { busy: false, stage: 'idle', message: 'Idle' },
  editingId: null,
  updateStatus: { state: 'idle' },
  updateDismissed: false,
  appearOffline: false,
  layout: { top: [], sections: [] }
};

let updateTransientTimer = null;
let dragKind = null; // 'card' | 'section'
let dragId = null;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function init() {
  state.regions = await api.listRegions();
  state.settings = await api.getSettings();
  state.status = await api.getStatus();

  populateRegionSelect($('defaultRegion'));
  populateRegionSelect($('fRegion'));
  $('defaultRegion').value = state.settings.defaultRegion;
  $('startWithWindows').checked = !!state.settings.startWithWindows;
  $('autoUpdate').checked = !!state.settings.autoUpdate;
  $('autoAcceptDelay').value = Math.round((state.settings.autoAcceptDelayMs ?? 2000) / 1000);
  state.appearOffline = !!(await api.getAppearOffline()).on;
  renderClientToggles();

  await reloadAccounts();
  renderStatus();
  wireEvents();

  api.onAppearOffline((s) => {
    state.appearOffline = !!(s && s.on);
    renderClientToggles();
  });

  api.onStatus((status) => {
    const wasBusy = state.status.busy;
    state.status = status;
    renderStatus();
    if (wasBusy && !status.busy) reloadAccounts();
    renderAccounts(); // refresh disabled states
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

  const top = document.createElement('div');
  top.className = 'card-top';
  top.appendChild(el('span', 'card-name', account.label));
  if (account.region) top.appendChild(el('span', 'badge region', regionShort(account.region)));
  if (account.isCurrent) top.appendChild(el('span', 'badge active', 'Active'));
  card.appendChild(top);

  if (account.username) card.appendChild(el('div', 'card-sub', account.username));

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
  if (account.lastSummonerName) {
    meta.appendChild(el('span', 'dot', '·'));
    meta.appendChild(el('span', 'tag', account.lastSummonerName));
  }
  card.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  actions.appendChild(btn('Switch', 'btn primary small', busy, () => doSwitch(account.id)));
  actions.appendChild(btn('Capture', 'btn small', busy, () => doCapture(account)));
  actions.appendChild(btn('Edit', 'btn small ghost', busy, () => openForm(account)));
  actions.appendChild(btn('Delete', 'btn small danger', busy, () => doDelete(account)));
  card.appendChild(actions);

  return card;
}

function renderStatus() {
  const panel = $('statusPanel');
  const status = state.status;
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
    actions.appendChild(btn('Dismiss', 'btn small ghost', false, () => {
      panel.classList.add('hidden');
    }));
  }
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
    actions.appendChild(btn('Dismiss', 'btn small ghost', false, () => {
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
  const mismatch = !!(signedIn && account.lastSummonerName &&
    signedIn.trim().toLowerCase() !== account.lastSummonerName.trim().toLowerCase());

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
  renderClientToggles();
  renderUpdateBanner(); // autoUpdate affects banner text/actions
}

// Reflects the auto-accept (green on / red off) and appear-offline (green / gray) toolbar buttons.
function renderClientToggles() {
  const accept = $('autoAcceptBtn');
  const on = !!state.settings.autoAccept;
  accept.textContent = on ? 'Auto Accept On' : 'Auto Accept Off';
  accept.classList.toggle('on', on);
  accept.classList.toggle('off', !on);

  const offline = $('appearOfflineBtn');
  offline.classList.toggle('offline-on', !!state.appearOffline);
  offline.title = state.appearOffline ? 'Appearing offline — click to go online' : 'Appear offline';
}

// ---------------------------------------------------------------------------
// Status helpers (transient client-side messages during blocking calls)
// ---------------------------------------------------------------------------
function setStatusBusy(message) {
  const panel = $('statusPanel');
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
function wireEvents() {
  $('addBtn').addEventListener('click', () => openForm());
  $('helpBtn').addEventListener('click', () => api.openHelp());
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
  $('autoAcceptDelay').addEventListener('change', (e) => {
    const seconds = Math.min(10, Math.max(0, Math.round(Number(e.target.value) || 0)));
    e.target.value = seconds;
    onSettingChange({ autoAcceptDelayMs: seconds * 1000 });
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
function btn(label, className, disabled, onClick) {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.disabled = !!disabled;
  if (onClick) b.addEventListener('click', onClick);
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
