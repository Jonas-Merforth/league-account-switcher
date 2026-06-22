const api = window.api;
const $ = (id) => document.getElementById(id);

const state = {
  accounts: [],
  regions: [],
  settings: { defaultRegion: 'euw', startWithWindows: true },
  status: { busy: false, stage: 'idle', message: 'Idle' },
  editingId: null
};

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

  await reloadAccounts();
  renderStatus();
  wireEvents();

  api.onStatus((status) => {
    const wasBusy = state.status.busy;
    state.status = status;
    renderStatus();
    if (wasBusy && !status.busy) reloadAccounts();
    renderAccounts(); // refresh disabled states
  });
  api.onAccountsChanged(() => reloadAccounts());
}

async function reloadAccounts() {
  state.accounts = await api.listAccounts();
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

  const busy = state.status.busy;
  for (const account of state.accounts) {
    list.appendChild(renderCard(account, busy));
  }
}

function renderCard(account, busy) {
  const card = document.createElement('div');
  card.className = 'account-card' + (account.isCurrent ? ' is-current' : '');

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
  const ok = await confirmDialog(
    'Capture session',
    `This closes the Riot Client to save <b>${escapeHtml(account.label)}</b>'s current "Stay signed in" session. ` +
    `Make sure you're signed in as this account right now. Continue?`,
    'Capture'
  );
  if (!ok) return;
  try {
    setStatusBusy('Capturing session… the Riot Client will close.');
    const result = await api.captureAccount(account.id);
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

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function wireEvents() {
  $('addBtn').addEventListener('click', () => openForm());
  $('helpBtn').addEventListener('click', () => api.openHelp());
  $('emptyHelp').addEventListener('click', (e) => { e.preventDefault(); api.openHelp(); });

  $('defaultRegion').addEventListener('change', (e) => onSettingChange({ defaultRegion: e.target.value }));
  $('startWithWindows').addEventListener('change', (e) => onSettingChange({ startWithWindows: e.target.checked }));

  $('formCancel').addEventListener('click', closeForm);
  $('formSave').addEventListener('click', saveForm);
  $('formOverlay').addEventListener('click', (e) => { if (e.target === $('formOverlay')) closeForm(); });

  $('confirmOk').addEventListener('click', () => resolveConfirm(true));
  $('confirmCancel').addEventListener('click', () => resolveConfirm(false));
  $('confirmOverlay').addEventListener('click', (e) => { if (e.target === $('confirmOverlay')) resolveConfirm(false); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('formOverlay').classList.contains('hidden')) closeForm();
      else if (!$('confirmOverlay').classList.contains('hidden')) resolveConfirm(false);
    }
    if (e.key === 'Enter' && !$('formOverlay').classList.contains('hidden')) saveForm();
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
