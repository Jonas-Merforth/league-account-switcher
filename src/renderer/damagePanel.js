let timer;
let initialized = false;
let pending = false;
let actionError = '';
let targetScope = 'champion';
let metric = 'reported';
let refreshQueued = false;
let lastState = null;
let lastRendered = '';
let panelActive = false;
const get = (id) => document.getElementById(id);
const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 });
const recapTime = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1, maximumFractionDigits: 1, roundingMode: 'halfEven', useGrouping: false
});
const TYPES = ['physical', 'magic', 'true'];
const TYPE_NAMES = { physical: 'Physical', magic: 'Magic', true: 'True' };
const GROUP_GLYPHS = { attack: 'AA', item: '◆', augment: '✦', rune: '◈', summoner: '✶', other: '•', unattributed: '~' };
const GROUP_LABELS = { item: 'Item', augment: 'Augment', rune: 'Rune', summoner: 'Summoner spell' };
const STATUS = {
  off: 'Not recording',
  starting: 'Waiting for administrator permission',
  waiting: 'Ready. Start a League match.',
  capturing: 'Recording',
  stopping: 'Stopping…',
  converting: 'Stopping…',
  complete: 'Recording finished'
};

function clock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const rest = `${String(Math.floor(total / 60) % 60).padStart(hours ? 2 : 1, '0')}:${String(total % 60).padStart(2, '0')}`;
  return hours ? `${hours}:${rest}` : rest;
}

function recapSeconds(duration) {
  // League rounds the float to hundredths before formatting it to tenths.
  const hundredths = Math.trunc(Math.fround(Math.fround(duration * 100) + 0.4999999701976776));
  return `${recapTime.format(Math.fround(hundredths / 100))} s`;
}

function sourceChip(result) {
  if (result?.fromMatchHistory) return result.includesPracticeDummies ? 'Match History · incl. dummies' : 'Match History';
  if (result?.fromHealth) return result.matchedHits !== result.hits ? 'HP loss · partial' : 'HP loss';
  return 'Reported';
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function renderTypes(card, types) {
  const box = card.querySelector('.damage-types');
  const values = TYPES.map((type) => Math.max(0, types?.[type] || 0));
  const sum = values.reduce((total, value) => total + value, 0);
  box.classList.toggle('hidden', !(sum > 0));
  if (!(sum > 0)) return;
  TYPES.forEach((type, index) => {
    const share = values[index] / sum;
    const segment = box.querySelector(`.damage-type-bar [data-type="${type}"]`);
    segment.style.width = `${share * 100}%`;
    segment.classList.toggle('hidden', values[index] <= 0);
    const legend = box.querySelector(`.damage-type-legend [data-type="${type}"]`);
    legend.classList.toggle('hidden', values[index] <= 0);
    legend.querySelector('b').textContent = whole.format(values[index]);
    legend.title = `${percent.format(share)} of typed damage`;
  });
}

const share = (amount, sum) => !(sum > 0) ? '' : amount / sum < 0.005 ? '<1%' : percent.format(amount / sum);

function sourceRow(source, top, sum) {
  const row = element('li', `damage-row group-${source.group || 'other'}`);
  const glyph = source.slot || GROUP_GLYPHS[source.group] || '•';
  const badge = element('span', 'damage-slot', glyph);
  badge.dataset.group = source.group || 'other';
  if (source.slot && source.group === 'ability') badge.dataset.slot = source.slot;
  if (GROUP_LABELS[source.group]) badge.title = GROUP_LABELS[source.group];
  const name = element('span', 'damage-row-name', source.name);
  const detail = source.detail || GROUP_LABELS[source.group];
  if (detail) name.append(element('small', null, detail));
  name.title = detail ? `${source.name} · ${detail}` : source.name;
  const bar = element('span', 'damage-row-bar');
  const fill = element('i');
  fill.style.width = `${top > 0 ? Math.max(1.5, (source.amount / top) * 100) : 0}%`;
  bar.append(fill);
  row.append(badge, name, element('span', 'damage-row-value', whole.format(source.amount)),
    element('span', 'damage-row-share', share(source.amount, sum)), bar);
  return row;
}

function renderCard(id, result, { recap = false, live = false } = {}) {
  const card = get(id);
  const total = result?.displayTotal ?? result?.total;
  card.querySelector('.damage-value').textContent = total != null ? whole.format(total) : '—';
  const chip = result?.fromDeathRecap ? 'Death Recap'
    : id === 'damageFight' && !result?.fromHealth ? 'Estimate' : sourceChip(result);
  card.querySelector('.damage-source').textContent = chip;
  card.querySelector('.damage-source').classList.toggle('hidden', !result);
  card.querySelector('.damage-live').classList.toggle('hidden', !live);
  const details = [];
  if (result?.dps != null) details.push(`${oneDecimal.format(result.dps)} DPS`);
  if (result && recap) details.push(recapSeconds(result.duration));
  else if (result && id === 'damageFight') details.push(`${oneDecimal.format(result.duration)} s`);
  else if (result?.duration > 0) details.push(clock(result.duration));
  if (result?.fromHealth && result.matchedHits !== result.hits) details.push(`${whole.format(result.matchedHits)} of ${whole.format(result.hits)} hits matched`);
  else if (Number.isInteger(result?.hits)) details.push(`${whole.format(result.hits)} ${result.hits === 1 ? 'hit' : 'hits'}`);
  if (result?.sourcesUnavailable) details.push('Source totals unavailable');
  else if (result?.fromDeathRecap && result.sources.length) details.push('Captured sources');
  card.querySelector('.damage-rate').textContent = details.join(' · ');
  renderTypes(card, result?.displayTypes ?? result?.types);

  const rows = (result?.sources || []).filter((source) => source.amount > 0);
  if (result?.unattributed > 0) rows.push({ group: 'unattributed', name: 'Unattributed HP loss', amount: result.unattributed });
  rows.sort((a, b) => b.amount - a.amount);
  const sum = rows.reduce((total, source) => total + source.amount, 0);
  const list = card.querySelector('.damage-breakdown');
  list.replaceChildren(...rows.map((source) => sourceRow(source, rows[0]?.amount || 0, sum)));
  card.querySelector('.damage-empty').classList.toggle('hidden', !!result && (rows.length > 0 || result.total > 0));
}

function attackerBadge(name) {
  const words = name.split(/[\s.'’&,]+/).filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).replace(/^./, (letter) => letter.toUpperCase());
}

function attackerRow(attacker, top, sum) {
  const enemy = attacker.kind === 'champion';
  const row = element('li', `damage-row damage-attacker group-${enemy ? 'enemy' : 'other'}`);
  const badge = element('span', 'damage-slot', enemy ? attackerBadge(attacker.name) : '•');
  badge.dataset.group = enemy ? 'enemy' : 'other';
  const name = element('span', 'damage-row-name', attacker.name);
  const types = TYPES.map((type) => [type, Math.max(0, attacker.types?.[type] || 0)]).filter(([, value]) => value > 0);
  row.title = [attacker.name, ...types.map(([type, value]) => `${TYPE_NAMES[type]} ${whole.format(value)}`)].join(' · ');
  const bar = element('span', 'damage-row-bar');
  const split = element('span', 'damage-split');
  split.style.width = `${top > 0 ? Math.max(1.5, (attacker.amount / top) * 100) : 0}%`;
  const typed = types.reduce((total, [, value]) => total + value, 0);
  for (const [type, value] of types) {
    const segment = element('i');
    segment.dataset.type = type;
    segment.style.width = `${(value / typed) * 100}%`;
    split.append(segment);
  }
  bar.append(split);
  row.append(badge, name, element('span', 'damage-row-value', whole.format(attacker.amount)),
    element('span', 'damage-row-share', share(attacker.amount, sum)), bar);
  return row;
}

// Damage the player received, ranked by attacker.
function renderTaken(incoming) {
  const card = get('damageTaken');
  const has = incoming?.total > 0;
  card.querySelector('.damage-value').textContent = has ? whole.format(incoming.total) : '—';
  card.querySelector('.damage-source').classList.toggle('hidden', !has);
  const details = [];
  if (incoming?.duration > 0 && has) details.push(clock(incoming.duration));
  if (has) details.push(`${whole.format(incoming.hits)} ${incoming.hits === 1 ? 'hit' : 'hits'}`);
  card.querySelector('.damage-rate').textContent = details.join(' · ');
  renderTypes(card, has ? incoming.types : null);
  const rows = (incoming?.attackers || []).filter((attacker) => attacker.amount > 0);
  const sum = rows.reduce((total, attacker) => total + attacker.amount, 0);
  card.querySelector('.damage-breakdown').replaceChildren(...rows.map((attacker) =>
    attackerRow(attacker, Math.max(...rows.map((row) => row.amount)), sum)));
  const empty = card.querySelector('.damage-empty');
  empty.textContent = incoming?.unidentified
    ? 'Enemy champions could not be identified. Start tracking before the match, or switch to All targets.'
    : 'No damage taken yet.';
  empty.classList.toggle('hidden', rows.length > 0);
}

function renderStatus(state) {
  const box = get('damageStatus');
  const stateName = actionError || state.error ? 'error' : state.state || 'off';
  box.dataset.state = stateName;
  const text = actionError || state.error ||
    (state.state === 'complete' && /before a game/i.test(state.detail || '') ? state.detail : STATUS[state.state]) ||
    state.detail || STATUS.off;
  get('damageRecordingStatus').textContent = text;
  get('damageGameTime').textContent = state.gameTime == null ? '' : clock(state.gameTime);
  const toggle = get('damageToggle');
  const stopping = ['stopping', 'converting'].includes(state.state);
  toggle.textContent = state.busy ? (stopping ? 'Stopping…' : 'Stop tracking') : 'Start tracking';
  toggle.classList.toggle('primary', !state.busy);
  toggle.classList.toggle('danger', !!state.busy);
  toggle.disabled = stopping;
  get('damageFolder').disabled = !state.sessionDirectory;
  get('damageRecordingDetails').textContent = state.sessionDirectory
    ? `This recording: ${whole.format(state.samples)} game snapshots · ${state.originalLogSaved ? 'game log saved' : 'game log not saved yet'}.` : '';
}

function render(state) {
  lastState = state;
  // Skip DOM work when the meter has not changed since the last refresh.
  const signature = JSON.stringify([state, actionError]);
  if (signature === lastRendered) return;
  lastRendered = signature;
  renderStatus(state);
  const meter = state.meter;
  const coverage = meter
    ? [meter.targetScope, meter.incomplete && 'partial coverage', meter.missed && `${whole.format(meter.missed)} missing packets`].filter(Boolean).join(' · ')
    : state.meterStatus || (state.busy ? 'Waiting for game data.' : 'Start tracking to see your damage.');
  get('damageCoverage').textContent = coverage.charAt(0).toUpperCase() + coverage.slice(1);
  get('damageCoverage').classList.toggle('warn', !!meter?.incomplete);
  const matchTotal = metric === 'reported' || targetScope === 'all' ? state.matchTotals?.[targetScope] : undefined;
  renderCard('damageTotal', matchTotal ?? meter?.total);
  renderFight(meter);
  renderTaken(state.incoming);
}

function renderFight(meter) {
  const recap = meter?.deathRecap;
  const fight = recap ?? meter?.fights.at(-1);
  renderCard('damageFight', fight, { recap: !!recap, live: !recap && !!fight?.active });
}

async function refresh() {
  if (pending) { refreshQueued = true; return; }
  pending = true;
  const requestedScope = targetScope;
  const requestedMetric = metric;
  try {
    const state = await window.api.getDamageStatus(requestedScope, requestedMetric);
    if (requestedScope === targetScope && requestedMetric === metric) render(state);
  }
  catch (error) {
    get('damageStatus').dataset.state = 'error';
    get('damageRecordingStatus').textContent = error.message;
  }
  finally {
    pending = false;
    if (refreshQueued) { refreshQueued = false; void refresh(); }
  }
}

function refreshDamageSelection() {
  lastRendered = '';
  get('damageCoverage').textContent = 'Loading damage…';
  renderCard('damageTotal');
  renderFight();
  renderTaken();
  void refresh();
}

function bind(id, action) {
  get(id).addEventListener('click', async () => {
    const button = get(id);
    button.disabled = true;
    actionError = '';
    try { await action(); }
    catch (error) { actionError = error.message; }
    finally {
      button.disabled = false;
      lastRendered = '';
      await refresh();
    }
  });
}

export function setDamagePanelActive(active) {
  if (!initialized) {
    bind('damageToggle', () => lastState?.busy ? window.api.stopDamageRecording() : window.api.startDamageRecording());
    bind('damageFolder', () => window.api.openDamageFolder());
    for (const option of document.querySelectorAll('[name="damageTargets"]')) {
      option.checked = option.value === targetScope;
      option.addEventListener('change', () => {
        if (!option.checked) return;
        targetScope = option.value;
        refreshDamageSelection();
      });
    }
    const hpMode = get('damageHpMode');
    hpMode.checked = metric === 'hp';
    hpMode.addEventListener('change', () => {
      metric = hpMode.checked ? 'hp' : 'reported';
      refreshDamageSelection();
    });
    const fightGap = get('damageFightGap');
    let saved = null;
    try { saved = Number(localStorage.getItem('damageFightGap')); } catch { /* Storage unavailable. */ }
    if (Number.isInteger(saved) && saved >= 1 && saved <= 60) {
      fightGap.value = saved;
      window.api.setDamageFightGap(saved).catch(() => {});
    }
    fightGap.addEventListener('change', async () => {
      if (!fightGap.checkValidity() || !fightGap.value) {
        fightGap.value = localStorage.getItem('damageFightGap') || fightGap.defaultValue;
        return;
      }
      try {
        const state = await window.api.setDamageFightGap(Number(fightGap.value));
        localStorage.setItem('damageFightGap', String(state.fightGap));
        await refresh();
      } catch (error) { actionError = error.message; await refresh(); }
    });
    // Stop polling while the window is minimized, hidden in the tray or covered by the game.
    document.addEventListener('visibilitychange', schedule);
    initialized = true;
  }
  panelActive = active;
  schedule();
}

function schedule() {
  clearInterval(timer);
  timer = null;
  if (!panelActive || document.hidden) return;
  refresh();
  timer = setInterval(refresh, 1000);
}
