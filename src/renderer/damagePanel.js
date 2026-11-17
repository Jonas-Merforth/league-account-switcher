let timer;
let initialized = false;
let pending = false;
let actionError = '';
let targetScope = 'champion';
let teamView = 'match';
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
const GROUP_GLYPHS = { attack: 'AA', item: '◆', augment: '✦', rune: '◈', summoner: '✶', other: '•' };
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
    : id === 'damageFight' ? 'Estimate' : sourceChip(result);
  card.querySelector('.damage-source').textContent = chip;
  card.querySelector('.damage-source').classList.toggle('hidden', !result);
  card.querySelector('.damage-live').classList.toggle('hidden', !live);
  const details = [];
  if (result?.dps != null) details.push(`${oneDecimal.format(result.dps)} DPS`);
  if (result && recap) details.push(recapSeconds(result.duration));
  else if (result && id === 'damageFight') details.push(`${oneDecimal.format(result.duration)} s`);
  else if (result?.duration > 0) details.push(clock(result.duration));
  if (Number.isInteger(result?.hits)) details.push(`${whole.format(result.hits)} ${result.hits === 1 ? 'hit' : 'hits'}`);
  if (result?.sourcesUnavailable) details.push('Source totals unavailable');
  else if (result?.fromDeathRecap && result.sources.length) details.push('Captured sources');
  card.querySelector('.damage-rate').textContent = details.join(' · ');
  renderTypes(card, result?.displayTypes ?? result?.types);

  const rows = (result?.sources || []).filter((source) => source.amount > 0);
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

function partyRow(attacker, top, sum) {
  const enemy = attacker.kind === 'champion';
  const row = element('li', `damage-row damage-attacker group-${enemy ? 'enemy' : 'other'}`);
  const badge = element('span', 'damage-slot', enemy ? attackerBadge(attacker.name) : '•');
  badge.dataset.group = enemy ? 'enemy' : 'other';
  const name = element('span', 'damage-row-name', attacker.name);
  const types = TYPES.map((type) => [type, Math.max(0, attacker.types?.[type] || 0)]).filter(([, value]) => value > 0);
  row.title = [attacker.name, ...types.map(([type, value]) => `${TYPE_NAMES[type]} ${whole.format(value)}`)].join(' · ');
  // The killer's final hit has an amount but no verified damage school.
  if (attacker.finalHits > 0) types.push(['final-hit', attacker.finalHits]);
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
// Damage taken by attacker, or the player's damage by target.
function renderParties(id, summary, parties) {
  const card = get(id);
  const has = summary?.total > 0;
  card.querySelector('.damage-value').textContent = has ? whole.format(summary.total) : '—';
  card.querySelector('.damage-source').classList.toggle('hidden', !has);
  const details = [];
  if (summary?.duration > 0 && has) details.push(clock(summary.duration));
  if (has) details.push(`${whole.format(summary.hits)} ${summary.hits === 1 ? 'hit' : 'hits'}`);
  card.querySelector('.damage-rate').textContent = details.join(' · ');
  renderTypes(card, has ? summary.types : null);
  const rows = (parties || []).filter((attacker) => attacker.amount > 0);
  const sum = rows.reduce((total, attacker) => total + attacker.amount, 0);
  card.querySelector('.damage-breakdown').replaceChildren(...rows.map((attacker) =>
    partyRow(attacker, Math.max(...rows.map((row) => row.amount)), sum)));
  card.querySelector('.damage-empty').classList.toggle('hidden', rows.length > 0);
}

const TEAM_STATUS = {
  waiting: 'Waiting for the first confirmed team totals from League’s spectator feed.',
  unavailable: 'League has not published a spectator feed for this game.',
  unreadable: 'This version can’t read the team totals from League’s spectator feed.',
  error: 'Can’t reach League’s spectator feed. Retrying…'
};
const SIDE_NAMES = { ally: 'Your team', enemy: 'Enemy team', unknown: 'Players' };
const ordinal = (value) => {
  const rule = new Intl.PluralRules('en-US', { type: 'ordinal' }).select(value);
  return `${value}${{ one: 'st', two: 'nd', few: 'rd' }[rule] || 'th'}`;
};

function teamRow(player, side, metric, top, sum) {
  const amount = player[metric]?.total || 0;
  const row = partyRow({ name: player.name, kind: 'champion', amount, types: player[metric] }, top, sum);
  row.className = `damage-row damage-attacker damage-team-row group-${side === 'unknown' ? 'other' : side}${player.you ? ' is-you' : ''}`;
  const badge = row.querySelector('.damage-slot');
  badge.dataset.group = 'enemy';
  if (player.you) row.querySelector('.damage-row-name').append(element('span', 'damage-you', 'You'));
  row.title += ` · Taken ${whole.format(player.taken?.total || 0)} · ${player.kills}/${player.deaths}/${player.assists}`;
  return row;
}

function renderTakedowns(card, state) {
  const groups = state?.takedowns || [];
  const players = groups.flatMap((group) => group.players);
  const top = Math.max(0, ...players.map((player) => player.total));
  const ally = groups.find((group) => group.side === 'ally');
  const allyTotal = ally?.players.reduce((sum, row) => sum + row.total, 0);
  const chip = card.querySelector('.damage-source');
  chip.textContent = 'Captured takedowns';
  chip.classList.toggle('hidden', !players.length);
  card.querySelector('.damage-value').textContent = allyTotal == null ? '—' : whole.format(allyTotal);
  card.querySelector('.damage-rate').textContent = 'Your team · assist damage and final hits since tracking began';
  card.querySelector('.damage-team-list').replaceChildren(...groups.flatMap(({ side, players }) => {
    const sum = players.reduce((value, row) => value + row.total, 0);
    const head = element('div', 'damage-team-head', SIDE_NAMES[side]);
    head.append(element('b', null, whole.format(sum)));
    const list = element('ol', 'damage-breakdown');
    for (const player of [...players].sort((a, b) => b.total - a.total)) {
      const row = partyRow({ name: player.name, kind: 'champion', amount: player.total, types: player, finalHits: player.finalHits }, top, sum);
      row.className = `damage-row damage-attacker group-${side}${player.you ? ' is-you' : ''}`;
      if (player.you) row.querySelector('.damage-row-name').append(element('span', 'damage-you', 'You'));
      const assist = player.physical + player.magic + player.true;
      const detail = `${whole.format(assist)} on assists · ${whole.format(player.finalHits)} on final hits`;
      row.append(element('small', 'damage-takedown-detail', detail));
      row.title += ` · ${detail}`;
      list.append(row);
    }
    return [head, list];
  }));
  const empty = card.querySelector('.damage-empty');
  empty.textContent = state?.busy ? 'Waiting for a captured champion takedown.' : 'No champion takedown damage recorded.';
  empty.classList.toggle('hidden', players.length > 0);
}

// Every player's damage from the latest spectator keyframe, or Match History
// after the game. The target switch picks champion or all-target damage.
function renderTeam(team, state) {
  const card = get('damageTeam');
  if (teamView === 'takedowns') { renderTakedowns(card, state); return; }
  const metric = targetScope === 'all' ? 'all' : 'champion';
  const teams = (team?.teams || []).filter((group) => group.players.length);
  const final = team?.source === 'matchHistory';
  const chip = card.querySelector('.damage-source');
  chip.textContent = final ? 'Match History' : 'Spectator feed';
  chip.classList.toggle('hidden', !teams.length);
  const amount = (player) => player[metric]?.total || 0;
  const allies = teams.find((group) => group.side === 'ally')?.players || [];
  const me = allies.find((player) => player.you);
  const allyTotal = allies.reduce((total, player) => total + amount(player), 0);
  card.querySelector('.damage-value').textContent = me && allyTotal > 0 ? share(amount(me), allyTotal) : '—';
  const details = [];
  if (me && allyTotal > 0) {
    const rank = [...allies].sort((a, b) => amount(b) - amount(a)).indexOf(me) + 1;
    details.push(`${ordinal(rank)} of ${allies.length} on your team`, `${whole.format(amount(me))} of ${whole.format(allyTotal)}`);
  }
  if (final) details.push('Final');
  else if (teams.length && Number.isFinite(team.gameTime)) {
    details.push(`as of ${clock(team.gameTime)}`);
    if (team.behind != null) details.push(`${clock(team.behind)} behind`);
  }
  if (teams.length && !team.identified) details.push('Champions unidentified');
  card.querySelector('.damage-rate').textContent = details.join(' · ');

  const top = Math.max(0, ...teams.flatMap((group) => group.players.map(amount)));
  const list = card.querySelector('.damage-team-list');
  list.replaceChildren(...teams.flatMap((group) => {
    const players = [...group.players].sort((a, b) => amount(b) - amount(a));
    const sum = players.reduce((total, player) => total + amount(player), 0);
    const head = element('div', 'damage-team-head', SIDE_NAMES[group.side] || SIDE_NAMES.unknown);
    head.append(element('b', null, whole.format(sum)));
    const rows = element('ol', 'damage-breakdown');
    rows.append(...players.map((player) => teamRow(player, group.side, metric, top, sum)));
    return [head, rows];
  }));
  const empty = card.querySelector('.damage-empty');
  empty.textContent = TEAM_STATUS[team?.state] || (state?.busy ? 'Team stats start once the match is found.'
    : 'Start tracking to compare your damage with your team.');
  empty.classList.toggle('hidden', teams.length > 0);
  if (!teams.length) {
    const attackers = (state?.incoming?.attackers || []).filter((row) => row.kind === 'champion' && row.amount > 0);
    if (attackers.length) {
      // A single defender can confirm this subset immediately, even in a game
      // with no spectator feed. Its shares refer only to the damage shown.
      chip.textContent = 'Captured hits';
      chip.classList.remove('hidden');
      const total = attackers.reduce((sum, row) => sum + row.amount, 0);
      card.querySelector('.damage-value').textContent = whole.format(total);
      card.querySelector('.damage-rate').textContent = 'Champion damage to you' +
        (state.meter?.partial ? ` · tracked from ${clock(state.meter.startedAt)}` : '') +
        (state.meter?.gaps ? ' · partial coverage' : '');
      const rows = element('ol', 'damage-breakdown');
      const top = Math.max(...attackers.map((row) => row.amount));
      rows.append(...attackers.sort((a, b) => b.amount - a.amount).map((row) => partyRow(row, top, total)));
      list.replaceChildren(rows);
      if (!TEAM_STATUS[team?.state]) empty.textContent = 'Full team totals need a spectator update.';
    }
  }
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
    ? [meter.targetScope, meter.partial && `tracked from ${clock(meter.startedAt)}`, meter.gaps && 'partial coverage',
      meter.missed && `${whole.format(meter.missed)} missing packets`].filter(Boolean).join(' · ')
    : state.meterStatus || (state.busy ? 'Waiting for game data.' : 'Start tracking to see your damage.');
  get('damageCoverage').textContent = coverage.charAt(0).toUpperCase() + coverage.slice(1);
  get('damageCoverage').classList.toggle('warn', !!(meter?.partial || meter?.gaps));
  const matchTotal = state.matchTotals?.[targetScope];
  renderCard('damageTotal', matchTotal ?? meter?.total);
  renderTeam(state.team, state);
  renderFight(meter);
  renderParties('damageTaken', state.incoming, state.incoming?.attackers);
  renderParties('damageDealt', state.dealt, state.dealt?.targets);
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
  try {
    const state = await window.api.getDamageStatus(requestedScope);
    if (requestedScope === targetScope) render(state);
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
  renderTeam(lastState?.team, lastState);
  renderFight();
  renderParties('damageTaken');
  renderParties('damageDealt');
  void refresh();
}

const CARD_IDS = ['damageTotal', 'damageTeam', 'damageFight', 'damageTaken', 'damageDealt'];
const cards = () => [...document.querySelectorAll('#damageTabPanel > .damage-card')];

function saveCardOrder() {
  try { localStorage.setItem('damageCardOrder', JSON.stringify(cards().map((card) => card.id))); } catch { /* Storage unavailable. */ }
}

function moveCard(card, step) {
  const list = cards();
  const neighbor = list[list.indexOf(card) + step];
  if (!neighbor) return;
  if (step < 0) neighbor.before(card);
  else neighbor.after(card);
  saveCardOrder();
}

// Cards reorder by dragging their header, or with the arrow keys on the grip.
function setupCardOrder() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('damageCardOrder')); } catch { /* Storage unavailable. */ }
  const about = document.querySelector('#damageTabPanel > .damage-about');
  // Cards added after the order was saved go to the end.
  if (Array.isArray(saved)) {
    const order = [...new Set(saved.filter((id) => CARD_IDS.includes(id))), ...CARD_IDS.filter((id) => !saved.includes(id))];
    for (const id of order) about.before(get(id));
  }
  let dragged = null;
  const panel = get('damageTabPanel');
  panel.addEventListener('dragover', (event) => { if (dragged) event.preventDefault(); });
  panel.addEventListener('drop', (event) => { if (dragged) event.preventDefault(); });
  for (const card of cards()) {
    const head = card.querySelector('.damage-card-head');
    const title = head.querySelector('h3').textContent;
    const grip = element('button', 'damage-grip');
    grip.type = 'button';
    grip.title = 'Drag to reorder. Arrow keys move the card.';
    grip.setAttribute('aria-label', `Move the ${title} card`);
    grip.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      moveCard(card, event.key === 'ArrowUp' ? -1 : 1);
      grip.focus();
    });
    head.prepend(grip);
    head.draggable = true;
    head.addEventListener('dragstart', (event) => {
      dragged = card;
      card.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', card.id);
    });
    head.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      dragged = null;
      saveCardOrder();
    });
    card.addEventListener('dragover', (event) => {
      if (!dragged || dragged === card) return;
      const { top, height } = card.getBoundingClientRect();
      if (event.clientY > top + height / 2) card.after(dragged);
      else card.before(dragged);
    });
  }
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
    setupCardOrder();
    try { teamView = localStorage.getItem('teamDamageView') === 'takedowns' ? 'takedowns' : 'match'; } catch { /* Use default. */ }
    for (const option of document.querySelectorAll('[name="teamDamageView"]')) {
      option.checked = option.value === teamView;
      option.addEventListener('change', () => {
        if (!option.checked) return;
        teamView = option.value;
        try { localStorage.setItem('teamDamageView', teamView); } catch { /* Session preference still applies. */ }
        renderTeam(lastState?.team, lastState);
      });
    }
    for (const option of document.querySelectorAll('[name="damageTargets"]')) {
      option.checked = option.value === targetScope;
      option.addEventListener('change', () => {
        if (!option.checked) return;
        targetScope = option.value;
        refreshDamageSelection();
      });
    }
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
