import { healedBack } from '../core/healingTracker.js';
import { pairGoldMatchups } from '../core/goldMatchups.js';

let timer;
let initialized = false;
let pending = false;
let actionError = '';
let actionPending = '';
let targetScope = 'champion';
let teamView = 'match';
let goldView = 'team';
let refreshQueued = false;
let lastState = null;
let recording = null;
let savedId = '';
let historyGames = [];
let historyRevision = null;
let lastRendered = '';
let panelActive = false;
// Long source lists show the top rows until expanded. Collapsed on every start.
const COLLAPSED_ROWS = 5;
const expandedCards = new Set();
const lastCards = new Map();
const get = (id) => document.getElementById(id);
const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 });
const gameDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });
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
  if (result?.beforeRecording != null) return 'Spectator + capture';
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

function renderCard(id, result, options = {}) {
  const { recap = false, live = false } = options;
  lastCards.set(id, [result, options]);
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
  if (Number.isInteger(result?.hits)) {
    const label = result.beforeRecording != null ? 'captured ' : '';
    details.push(`${whole.format(result.hits)} ${label}${result.hits === 1 ? 'hit' : 'hits'}`);
  }
  if (result?.breakdownTotal != null && Math.trunc(result.breakdownTotal) !== result.total) {
    details.push(`${whole.format(result.breakdownTotal)} in spectator + capture breakdown`);
  }
  if (result?.sourcesUnavailable) details.push('Source totals unavailable');
  else if (result?.fromDeathRecap && result.sources.length) details.push('Captured sources');
  card.querySelector('.damage-rate').textContent = details.join(' · ');
  renderTypes(card, result?.displayTypes ?? result?.types);

  const rows = (result?.sources || []).filter((source) => source.amount > 0);
  rows.sort((a, b) => b.amount - a.amount);
  const top = Math.max(rows[0]?.amount || 0, result?.beforeRecording || 0);
  const sources = rows.length;
  if (result?.beforeRecording > 0) {
    rows.push({ name: 'Before recording', group: 'before-recording', amount: result.beforeRecording });
  }
  const sum = rows.reduce((total, source) => total + source.amount, 0);
  // Shares stay relative to every source. Before recording is a summary row and always shows.
  const more = card.querySelector('.damage-more');
  const hidden = more && !expandedCards.has(id) ? Math.max(0, sources - COLLAPSED_ROWS) : 0;
  const shown = hidden ? [...rows.slice(0, COLLAPSED_ROWS), ...rows.slice(sources)] : rows;
  const list = card.querySelector('.damage-breakdown');
  list.replaceChildren(...shown.map((source) => sourceRow(source, top, sum)));
  if (more) {
    const expandable = sources > COLLAPSED_ROWS;
    more.classList.toggle('hidden', !expandable);
    more.setAttribute('aria-expanded', String(expandable && !hidden));
    more.textContent = hidden ? `Show ${hidden} more` : `Show top ${COLLAPSED_ROWS}`;
  }
  card.querySelector('.damage-empty').classList.toggle('hidden', !!result && (id === 'damageFight' || rows.length > 0 || result.total > 0));
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
  // Damage since the last confirmed totals has no damage school yet either.
  if (attacker.live > 0) types.push(['live', attacker.live]);
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
  row.append(badge, name, element('span', 'damage-row-value', (attacker.estimated ? '≈ ' : '') + whole.format(attacker.amount)),
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
const TEAM_DAMAGE_SOURCES = {
  matchHistory: ['Match History', 'Final damage totals reported by League after the match.'],
  spectator: ['Spectator feed', 'Damage totals from League’s delayed scoreboard. The Live badge marks damage added since the last update.'],
  live: ['Live estimate', 'Champion damage estimated from recent hits your game client sees.'],
  takedowns: ['Captured takedowns', 'Champion kills recorded by your game client since tracking began. Includes each killer’s finishing hit and damage League credits to assisters.']
};

function setTeamDamageSource(chip, source) {
  const [label, description] = TEAM_DAMAGE_SOURCES[source];
  chip.textContent = label;
  chip.title = description;
}

const ordinal = (value) => {
  const rule = new Intl.PluralRules('en-US', { type: 'ordinal' }).select(value);
  return `${value}${{ one: 'st', two: 'nd', few: 'rd' }[rule] || 'th'}`;
};

// The live part is the damage since the confirmed totals. A player's own
// hits are captured exactly. Everyone else's are estimated.
function teamRow(player, side, metric, top, sum, live, place) {
  const recent = live ? player.live?.champion || 0 : 0;
  const amount = (player[metric]?.total || 0) + recent;
  const estimated = live && player.live?.estimated > 0;
  const row = partyRow({ name: player.name, kind: 'champion', amount, types: player[metric], live: recent, estimated }, top, sum);
  row.className = `damage-row damage-attacker damage-team-row group-${side === 'unknown' ? 'other' : side}${player.you ? ' is-you' : ''}`;
  const badge = row.querySelector('.damage-slot');
  badge.dataset.group = 'enemy';
  if (player.you) row.querySelector('.damage-row-name').append(element('span', 'damage-you', place ? `You · ${ordinal(place)}` : 'You'));
  if (recent > 0) row.title += ` · ${estimated ? 'Live estimate' : 'Captured live'} ${whole.format(recent)}`;
  if (player.taken?.total > 0) row.title += ` · Taken ${whole.format(player.taken.total)}`;
  row.title += ` · ${player.kills}/${player.deaths}/${player.assists}`;
  return row;
}

// The Full match view leads with your place on your team. Other views show a plain figure.
function setPlace(card, place, of) {
  const value = card.querySelector('.damage-value');
  const label = card.querySelector('.damage-place-of');
  if (place) value.dataset.place = String(place);
  else delete value.dataset.place;
  label.textContent = place ? `of ${of} on your team` : '';
  label.classList.toggle('hidden', !place);
}

function renderTakedowns(card, state) {
  setPlace(card);
  const groups = state?.takedowns || [];
  const players = groups.flatMap((group) => group.players);
  const top = Math.max(0, ...players.map((player) => player.total));
  const ally = groups.find((group) => group.side === 'ally');
  const allyTotal = ally?.players.reduce((sum, row) => sum + row.total, 0);
  const chip = card.querySelector('.damage-source');
  setTeamDamageSource(chip, 'takedowns');
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
  card.querySelector('.damage-live').classList.add('hidden');
  if (teamView === 'takedowns') { renderTakedowns(card, state); return; }
  const teams = (team?.teams || []).filter((group) => group.players.length);
  const final = team?.source === 'matchHistory';
  // Without spectator totals the live estimate is the only figure, and it covers champions.
  const liveOnly = team?.source === 'live';
  const metric = targetScope === 'all' && !liveOnly ? 'all' : 'champion';
  // The live part bridges the spectator delay. It counts champion damage only.
  const live = !final && metric === 'champion' && team?.liveSince != null;
  const chip = card.querySelector('.damage-source');
  setTeamDamageSource(chip, final ? 'matchHistory' : liveOnly ? 'live' : 'spectator');
  chip.classList.toggle('hidden', !teams.length);
  card.querySelector('.damage-live').classList.toggle('hidden', !live || liveOnly || !teams.length || !state?.busy);
  const amount = (player) => (player[metric]?.total || 0) + (live ? player.live?.champion || 0 : 0);
  const allies = teams.find((group) => group.side === 'ally')?.players || [];
  const me = allies.find((player) => player.you);
  const allyTotal = allies.reduce((total, player) => total + amount(player), 0);
  const ranked = me && allyTotal > 0;
  const place = ranked ? [...allies].sort((a, b) => amount(b) - amount(a)).indexOf(me) + 1 : 0;
  card.querySelector('.damage-value').textContent = ranked ? ordinal(place) : '—';
  setPlace(card, place, allies.length);
  const details = [];
  if (ranked) {
    details.push(`${share(amount(me), allyTotal)} of your team’s damage`, `${whole.format(amount(me))} of ${whole.format(allyTotal)}`);
    const everyone = teams.flatMap((group) => group.players);
    if (teams.length > 1) {
      const overall = [...everyone].sort((a, b) => amount(b) - amount(a)).indexOf(me) + 1;
      details.push(`${ordinal(overall)} of ${everyone.length} in the game`);
    }
  }
  if (final) details.push('Final');
  else if (liveOnly && teams.length) {
    details.push(targetScope === 'all' ? 'Champion damage only' : null, `estimated from tracked hits since ${clock(team.liveSince)}`);
  } else if (teams.length && Number.isFinite(team.gameTime)) {
    if (live) details.push(`confirmed to ${clock(team.gameTime)}, estimated since`);
    else {
      details.push(`as of ${clock(team.gameTime)}`);
      if (team.behind != null) details.push(`${clock(team.behind)} behind`);
    }
  }
  if (live && team.liveGaps) details.push('partial coverage');
  if (teams.length && !team.identified) details.push('Champions unidentified');
  card.querySelector('.damage-rate').textContent = details.filter(Boolean).join(' · ');

  const top = Math.max(0, ...teams.flatMap((group) => group.players.map(amount)));
  const list = card.querySelector('.damage-team-list');
  list.replaceChildren(...teams.flatMap((group) => {
    const players = [...group.players].sort((a, b) => amount(b) - amount(a));
    const sum = players.reduce((total, player) => total + amount(player), 0);
    const estimated = live && players.some((player) => player.live?.estimated > 0);
    const head = element('div', 'damage-team-head', SIDE_NAMES[group.side] || SIDE_NAMES.unknown);
    head.append(element('b', null, (estimated ? '≈ ' : '') + whole.format(sum)));
    const rows = element('ol', 'damage-breakdown');
    rows.append(...players.map((player) => teamRow(player, group.side, metric, top, sum, live, player === me ? place : 0)));
    return [head, rows];
  }));
  const empty = card.querySelector('.damage-empty');
  empty.textContent = TEAM_STATUS[team?.state] || (state?.busy ? 'Team stats start once the match is found.'
    : 'Start tracking to compare your damage with your team.');
  empty.classList.toggle('hidden', teams.length > 0);
}

const percentOf = (value) => value < 0.005 ? '<1%' : percent.format(value);

// Healing bars split what a champion healed on itself and on teammates. The
// percentage is the share of the damage it took that it healed back.
function healRow(player, top, flagged) {
  const side = player.side === 'unknown' ? 'other' : player.side;
  const row = element('li', `damage-row damage-attacker damage-team-row group-${side}${player.you ? ' is-you' : ''}${flagged ? ' is-flagged' : ''}`);
  const badge = element('span', 'damage-slot', attackerBadge(player.name));
  badge.dataset.group = 'enemy';
  const name = element('span', 'damage-row-name', player.name);
  if (player.you) name.append(element('span', 'damage-you', 'You'));
  const bar = element('span', 'damage-row-bar');
  const split = element('span', 'damage-split');
  split.style.width = `${top > 0 && player.total > 0 ? Math.max(1.5, (player.total / top) * 100) : 0}%`;
  for (const [type, value] of [['heal-self', player.self], ['heal-allies', player.allies]]) {
    if (!(value > 0)) continue;
    const segment = element('i');
    segment.dataset.type = type;
    segment.style.width = `${(value / player.total) * 100}%`;
    split.append(segment);
  }
  bar.append(split);
  const back = healedBack(player);
  row.append(badge, name, element('span', 'damage-row-value', whole.format(player.total)),
    element('span', 'damage-row-share', back == null ? '' : percentOf(back)), bar);
  row.title = [player.name, `Self ${whole.format(player.self)}`, `Allies ${whole.format(player.allies)}`,
    `Received ${whole.format(player.received)}`, `Damage taken ${whole.format(player.taken)}`,
    back != null && `Healed back ${percentOf(back)} of damage taken`].filter(Boolean).join(' · ');
  return row;
}

function renderAntiHeal(card, advice, live) {
  const box = card.querySelector('.damage-antiheal');
  const healers = (advice?.healers || []).slice(0, 3);
  const owners = advice?.owners || [];
  box.classList.toggle('hidden', !healers.length);
  if (!healers.length) return;
  const [first, ...rest] = healers;
  const healing = `${first.name} heals back ${percent.format(first.share)} of damage taken` +
    (rest.length ? `, ${rest.map((healer) => `${healer.name} ${percent.format(healer.share)}`).join(', ')}.` : '.');
  box.dataset.tone = advice.recommended ? 'warn' : 'ok';
  card.querySelector('.damage-antiheal-title').textContent = advice.recommended
    ? (live ? 'Anti-heal recommended' : 'Anti-heal would have helped') : 'Your team has anti-heal';
  card.querySelector('.damage-antiheal-text').textContent = advice.recommended
    ? `${healing} Nobody on your team has a Wounds item yet.`
    : `${owners.map((owner) => `${owner.you ? 'You' : owner.name}: ${owner.item}`).join(' · ')}. ${healing}`;
}

// Every champion's healing since tracking began, grouped by team.
function renderHealing(healing, state) {
  const card = get('damageHealing');
  const players = healing?.players || [];
  const live = !!state?.busy && players.length > 0;
  const me = players.find((player) => player.you);
  card.querySelector('.damage-live').classList.toggle('hidden', !live);
  card.querySelector('.damage-source').classList.toggle('hidden', !players.length);
  card.querySelector('.damage-value').textContent = me ? whole.format(me.total) : '—';
  const details = [];
  if (me && healing.duration > 0) details.push(`${whole.format(me.total / healing.duration * 60)} per minute`);
  if (me?.allies > 0) details.push(`self ${whole.format(me.self)}`, `allies ${whole.format(me.allies)}`);
  if (players.length && healing.partial) details.push(`tracked from ${clock(healing.startedAt)}`);
  if (players.length && healing.gaps) details.push('partial coverage');
  const text = details.join(' · ');
  card.querySelector('.damage-rate').textContent = text.charAt(0).toUpperCase() + text.slice(1);
  renderAntiHeal(card, healing?.antiHeal, live);
  card.querySelector('.damage-heal-legend').classList.toggle('hidden', !players.length);
  const flagged = new Set((healing?.antiHeal?.healers || []).map((healer) => healer.name));
  const top = Math.max(0, ...players.map((player) => player.total));
  card.querySelector('.damage-team-list').replaceChildren(...['ally', 'enemy', 'unknown'].flatMap((side) => {
    const group = players.filter((player) => player.side === side).sort((a, b) => b.total - a.total);
    if (!group.length) return [];
    const head = element('div', 'damage-team-head', SIDE_NAMES[side]);
    head.append(element('b', null, whole.format(group.reduce((sum, player) => sum + player.total, 0))));
    const rows = element('ol', 'damage-breakdown');
    rows.append(...group.map((player) => healRow(player, top, side === 'enemy' && flagged.has(player.name))));
    return [head, rows];
  }));
  const empty = card.querySelector('.damage-empty');
  // Games saved before healing was tracked have no healing entry at all.
  empty.textContent = state?.busy ? 'Healing appears once the match starts.'
    : state?.sessionDirectory && !('healing' in state) ? 'This game was saved before healing was tracked. Your next tracked game will show it.'
      : state?.sessionDirectory ? 'No healing was recorded for this game.' : 'Start tracking to see everyone’s healing.';
  empty.classList.toggle('hidden', players.length > 0);
}

const GOLD_SOURCES = {
  matchHistory: ['Match History', 'Final total gold earned reported by League after the match.'],
  spectator: ['Spectator + live', 'Confirmed gold from League’s spectator feed, with live estimated income added since the last keyframe.'],
  live: ['Live estimate', 'Live gold estimated from passive income, CS, kills, assists, objectives and visible items. Your own gold is tracked directly.']
};

function signedGold(diff) {
  if (diff == null) return '';
  const rounded = Math.round(diff);
  if (rounded === 0) return '0';
  return `${rounded > 0 ? '+' : '−'}${whole.format(Math.abs(rounded))}`;
}

function goldPlayerTitle(player) {
  if (!player) return '';
  const parts = [player.name, `${player.estimated ? '≈ ' : ''}${whole.format(player.gold)} gold`];
  if (player.confirmedGold != null && player.liveGold > 0) {
    parts.push(`${whole.format(player.confirmedGold)} confirmed + ${player.estimated ? '≈ ' : ''}${whole.format(player.liveGold)} live`);
  }
  if (player.itemGold != null) parts.push(`Items ${whole.format(player.itemGold)}`);
  if (player.unspent != null) parts.push(`${player.you ? 'Unspent' : 'Est. unspent'} ${whole.format(player.unspent)}`);
  if (player.cs != null) parts.push(`${whole.format(player.cs)} CS`);
  if ([player.kills, player.deaths, player.assists].every((value) => Number.isInteger(value))) {
    parts.push(`${player.kills}/${player.deaths}/${player.assists}`);
  }
  return parts.join(' · ');
}

function goldSideNode(player, side) {
  const box = element('div', `gold-side ${side}${player?.you ? ' is-you' : ''}${!player ? ' is-empty' : ''}`);
  if (!player) return box;
  box.title = goldPlayerTitle(player);
  const badge = element('span', 'damage-slot gold-badge', attackerBadge(player.name));
  badge.dataset.group = 'enemy';
  const name = element('span', 'gold-name', player.name);
  if (player.you) name.append(element('span', 'damage-you', 'You'));
  const value = element('span', 'gold-value', `${player.estimated ? '≈' : ''}${whole.format(player.gold)}`);
  if (side === 'ally') box.append(badge, name, value);
  else box.append(value, name, badge);
  return box;
}

function goldMatchupRow(matchup, compact) {
  const row = element('li', `gold-row${matchup.isYou ? ' is-you' : ''}${compact ? ' is-compact' : ''}`);
  const center = element('div', 'gold-center');
  if (matchup.laneLabel) center.append(element('span', 'gold-lane', matchup.laneLabel));
  const diffValue = matchup.diff;
  if (diffValue != null) {
    const diff = element('span', 'gold-diff', signedGold(diffValue));
    diff.dataset.tone = diffValue > 0 ? 'ahead' : diffValue < 0 ? 'behind' : 'even';
    center.append(diff);
  }
  const allyGold = Math.max(0, matchup.ally?.gold || 0);
  const enemyGold = Math.max(0, matchup.enemy?.gold || 0);
  const sum = allyGold + enemyGold;
  const bar = element('span', 'gold-row-bar');
  const allyFill = element('i');
  allyFill.dataset.side = 'ally';
  allyFill.style.width = `${sum > 0 ? (allyGold / sum) * 100 : 50}%`;
  const enemyFill = element('i');
  enemyFill.dataset.side = 'enemy';
  enemyFill.style.width = `${sum > 0 ? (enemyGold / sum) * 100 : 50}%`;
  bar.append(allyFill, enemyFill);
  row.append(goldSideNode(matchup.ally, 'ally'), center, goldSideNode(matchup.enemy, 'enemy'), bar);
  if (compact) {
    const subParts = [];
    if (matchup.ally?.itemGold != null) {
      subParts.push(`Your items ${whole.format(matchup.ally.itemGold)}${matchup.ally.unspent != null ? ` · Unspent ${whole.format(matchup.ally.unspent)}` : ''}`);
    }
    if (matchup.enemy?.itemGold != null) {
      subParts.push(`Opp items ${whole.format(matchup.enemy.itemGold)}${matchup.enemy.unspent != null ? ` · Est. unspent ${whole.format(matchup.enemy.unspent)}` : ''}`);
    }
    if (subParts.length) row.append(element('small', 'gold-compact-detail', subParts.join(' · ')));
  }
  return row;
}

function renderGold(gold, state) {
  const card = get('damageGold');
  if (!card) return;
  const teams = (gold?.teams || []).filter((group) => group.players?.length);
  const hasData = teams.length > 0;
  const final = gold?.source === 'matchHistory';
  const liveOnly = gold?.source === 'live';
  const live = !final && hasData && !!state?.busy;

  const chip = card.querySelector('.damage-source');
  const [label, description] = GOLD_SOURCES[final ? 'matchHistory' : liveOnly ? 'live' : 'spectator'];
  chip.textContent = label;
  chip.title = description;
  chip.classList.toggle('hidden', !hasData);
  card.querySelector('.damage-live').classList.toggle('hidden', !live);

  const box = card.querySelector('.gold-team-box');
  box.classList.toggle('hidden', !hasData);

  const list = card.querySelector('.gold-matchups');
  const empty = card.querySelector('.damage-empty');
  if (!hasData) {
    list.replaceChildren();
    empty.textContent = state?.busy ? 'Gold appears once the match starts.'
      : state?.sessionDirectory && !('gold' in state) ? 'This game was saved before gold was tracked. Your next tracked game will show it.'
        : state?.sessionDirectory ? 'No gold was recorded for this game.' : 'Start tracking to compare everyone’s live gold.';
    empty.classList.remove('hidden');
    return;
  }

  const allyGroup = teams.find((group) => group.side === 'ally') || teams[0];
  const enemyGroup = teams.find((group) => group.side === 'enemy') || (teams.length > 1 ? teams[1] : null);
  const allyTotal = (allyGroup?.players || []).reduce((sum, player) => sum + (player.gold || 0), 0);
  const enemyTotal = (enemyGroup?.players || []).reduce((sum, player) => sum + (player.gold || 0), 0);
  const allyEstimated = (allyGroup?.players || []).some((player) => player.estimated);
  const enemyEstimated = (enemyGroup?.players || []).some((player) => player.estimated);
  const teamSum = allyTotal + enemyTotal;

  card.querySelector('.gold-ally-total').textContent = `${allyEstimated ? '≈ ' : ''}${whole.format(allyTotal)}`;
  card.querySelector('.gold-enemy-total').textContent = enemyGroup ? `${enemyEstimated ? '≈ ' : ''}${whole.format(enemyTotal)}` : '—';
  const diffNode = card.querySelector('.gold-team-diff');
  if (enemyGroup) {
    const diff = allyTotal - enemyTotal;
    diffNode.textContent = diff === 0 ? 'Even' : signedGold(diff);
    diffNode.dataset.tone = diff > 0 ? 'ahead' : diff < 0 ? 'behind' : 'even';
  } else {
    diffNode.textContent = '';
    diffNode.dataset.tone = 'even';
  }
  const allyBar = card.querySelector('.gold-team-bar [data-side="ally"]');
  const enemyBar = card.querySelector('.gold-team-bar [data-side="enemy"]');
  allyBar.style.width = `${teamSum > 0 ? (allyTotal / teamSum) * 100 : 50}%`;
  enemyBar.style.width = `${teamSum > 0 ? (enemyTotal / teamSum) * 100 : 50}%`;
  enemyBar.classList.toggle('hidden', !enemyGroup);

  const me = teams.flatMap((group) => group.players).find((player) => player.you);
  const details = [];
  if (final) details.push('Final total gold');
  else if (liveOnly) details.push('Estimated live');
  else if (Number.isFinite(gold.gameTime)) {
    details.push(gold.liveSince != null ? `Confirmed to ${clock(gold.gameTime)}, estimated since` : `As of ${clock(gold.gameTime)}`);
  }
  if (!final && me?.unspent != null) details.push(`Your unspent: ${whole.format(me.unspent)}`);
  card.querySelector('.gold-meta').textContent = details.join(' · ');

  const { rows } = pairGoldMatchups(teams);
  const compact = goldView === 'compact';
  const visible = compact ? [rows.find((row) => row.isYou) || rows[0]].filter(Boolean) : rows;
  list.replaceChildren(...visible.map((row) => goldMatchupRow(row, compact)));
  empty.classList.add('hidden');
}

function renderStatus(state, view) {
  const box = get('damageStatus');
  const stateName = actionError || state.error ? 'error' : state.state || 'off';
  box.dataset.state = stateName;
  const text = actionError || state.error || (state.state === 'error' && state.detail) ||
    state.captureLimit ||
    (state.continuous && state.state === 'waiting' && 'Always on · waiting for a match') ||
    (!state.busy && state.viewId && STATUS.complete) ||
    // A starting recorder may be waiting for the previous one rather than for Windows.
    (state.state === 'starting' && state.detail) ||
    (state.state === 'complete' && /before a game/i.test(state.detail || '') ? state.detail : STATUS[state.state]) ||
    state.detail || STATUS.off;
  get('damageRecordingStatus').textContent = text;
  const gameTime = state.busy ? state.gameTime : view.gameTime;
  get('damageGameTime').textContent = gameTime == null ? '' : clock(gameTime);
  const toggle = get('damageToggle');
  const stopping = ['stopping', 'converting'].includes(state.state);
  toggle.textContent = state.busy ? (stopping ? 'Stopping…' : 'Stop tracking') : 'Start tracking';
  toggle.classList.toggle('primary', !state.busy);
  toggle.classList.toggle('danger', !!state.busy);
  toggle.disabled = stopping || actionPending === 'damageToggle';
  get('damageMode').disabled = state.busy || actionPending === 'damageToggle';
  get('damageFolder').disabled = !view.sessionDirectory || actionPending === 'damageFolder';
  const fightGap = get('damageFightGap');
  fightGap.disabled = !!(savedId && state.viewId);
  if (fightGap.disabled || document.activeElement !== fightGap) {
    const gap = fightGap.disabled ? view.fightGap : state.fightGap;
    fightGap.value = gap ?? fightGap.defaultValue;
  }
  get('damageRetentionDetails').textContent = state.retainResearch
    ? 'Development builds keep game traffic, snapshots and the League log on this computer for replay and debugging.'
    : 'The app saves a damage summary and champion lineup for each match. Game traffic is temporarily captured while tracking.';
  get('damageRecordingDetails').textContent = view.sessionDirectory && view.retainResearch !== false
    ? `This recording: ${whole.format(view.samples)} game snapshots · ${view.originalLogSaved ? 'game log saved' : 'game log not saved yet'}.` : '';
}

function render(recordingState) {
  recording = recordingState;
  const state = recording.view ?? recording;
  lastState = state;
  renderStatus(recording, state);
  // Skip DOM work when the meter has not changed since the last refresh.
  const signature = JSON.stringify(state);
  if (signature === lastRendered) return;
  lastRendered = signature;
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
  renderHealing(state.healing, state);
  renderFight(meter);
  renderParties('damageTaken', state.incoming, state.incoming?.attackers);
  renderParties('damageDealt', state.dealt, state.dealt?.targets);
  renderGold(state.gold, state);
}

function renderFight(meter) {
  const recap = meter?.deathRecap;
  const fight = recap ?? meter?.fights.at(-1);
  renderCard('damageFight', fight, { recap: !!recap, live: !recap && !!fight?.active });
}

function renderHistory(games) {
  historyGames = games;
  const selector = get('damageHistory');
  selector.replaceChildren(element('option', null, 'Current / latest'));
  selector.options[0].value = '';
  for (const game of games) {
    const time = Date.parse(game.startedAt);
    const label = [game.champion, Number.isFinite(time) && gameDate.format(time)].filter(Boolean).join(' · ');
    const option = element('option', null, label || 'Saved game');
    option.value = game.id;
    selector.append(option);
  }
  const selected = games.find(game => game.recordings.some(part => part.id === savedId));
  selector.value = selected?.id || '';
  selector.title = selector.selectedOptions[0]?.textContent || '';
  const parts = get('damageRecording');
  parts.replaceChildren();
  get('damageRecordingSelect').classList.toggle('hidden', !(selected?.recordings.length > 1));
  if (selected?.recordings.length > 1) {
    for (const [index, part] of selected.recordings.entries()) {
      const option = element('option', null, `Part ${selected.recordings.length - index} · ${gameDate.format(Date.parse(part.startedAt))}`);
      option.value = part.id;
      parts.append(option);
    }
    parts.value = savedId;
  }
}

async function refresh() {
  if (!panelActive) return;
  if (pending) { refreshQueued = true; return; }
  pending = true;
  const requestedScope = targetScope;
  const requestedId = savedId;
  try {
    const state = await window.api.getDamageStatus(requestedScope, requestedId);
    if (requestedScope === targetScope && requestedId === savedId) render(state);
    if (state.historyRevision !== historyRevision) {
      renderHistory(await window.api.getDamageHistory());
      historyRevision = state.historyRevision;
      if (!state.sessionDirectory && !state.view) refreshQueued = true;
    }
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

function refreshDamageSelection({ changingGame = false } = {}) {
  lastRendered = '';
  get('damageCoverage').textContent = 'Loading damage…';
  renderCard('damageTotal');
  renderTeam(changingGame ? null : lastState?.team, changingGame ? null : lastState);
  renderHealing(changingGame ? null : lastState?.healing, changingGame ? null : lastState);
  renderFight();
  renderParties('damageTaken');
  renderParties('damageDealt');
  renderGold(changingGame ? null : lastState?.gold, changingGame ? null : lastState);
  void refresh();
}

const CARD_IDS = ['damageTotal', 'damageTeam', 'damageHealing', 'damageFight', 'damageTaken', 'damageDealt', 'damageGold'];

// A saved card order, with cards it does not know placed after the nearest
// card that comes before them by default.
export function mergeCardOrder(saved, defaults) {
  const order = [...new Set(saved.filter((id) => defaults.includes(id)))];
  defaults.forEach((id, index) => {
    if (order.includes(id)) return;
    const previous = defaults.slice(0, index).reverse().find((card) => order.includes(card));
    order.splice(previous ? order.indexOf(previous) + 1 : 0, 0, id);
  });
  return order;
}
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
  // Cards added after the order was saved go after the card they follow by default.
  if (Array.isArray(saved)) {
    for (const id of mergeCardOrder(saved, CARD_IDS)) about.before(get(id));
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
    if (actionPending) return;
    const button = get(id);
    actionPending = id;
    button.disabled = true;
    actionError = '';
    try { await action(); }
    catch (error) { actionError = error.message; }
    finally {
      actionPending = '';
      button.disabled = false;
      lastRendered = '';
      await refresh();
    }
  });
}

export function setDamagePanelActive(active) {
  if (!active && !initialized) return;
  if (!initialized) {
    bind('damageToggle', async () => {
      if (recording?.busy) return window.api.stopDamageRecording();
      await window.api.startDamageRecording(get('damageMode').value);
      if (savedId) {
        const history = get('damageHistory');
        history.value = '';
        history.title = history.selectedOptions[0]?.textContent || '';
        savedId = '';
        renderHistory(historyGames);
      }
    });
    bind('damageFolder', () => window.api.openDamageFolder(recording?.viewId));
    get('damageHistory').addEventListener('change', (event) => {
      savedId = event.target.value;
      renderHistory(historyGames);
      refreshDamageSelection({ changingGame: true });
    });
    get('damageRecording').addEventListener('change', (event) => {
      savedId = event.target.value;
      refreshDamageSelection({ changingGame: true });
    });
    setupCardOrder();
    for (const more of document.querySelectorAll('#damageTabPanel .damage-more')) {
      const id = more.closest('.damage-card').id;
      more.addEventListener('click', () => {
        if (!expandedCards.delete(id)) expandedCards.add(id);
        if (lastCards.has(id)) renderCard(id, ...lastCards.get(id));
      });
    }
    try { teamView = localStorage.getItem('teamDamageView') === 'takedowns' ? 'takedowns' : 'match'; } catch { /* Use default. */ }
    for (const option of document.querySelectorAll('[name="teamDamageView"]')) {
      option.setAttribute('aria-description', option.closest('label').title);
      option.checked = option.value === teamView;
      option.addEventListener('change', () => {
        if (!option.checked) return;
        teamView = option.value;
        try { localStorage.setItem('teamDamageView', teamView); } catch { /* Session preference still applies. */ }
        renderTeam(lastState?.team, lastState);
      });
    }
    try { goldView = localStorage.getItem('goldView') === 'compact' ? 'compact' : 'team'; } catch { /* Use default. */ }
    for (const option of document.querySelectorAll('[name="goldView"]')) {
      option.setAttribute('aria-description', option.closest('label').title);
      option.checked = option.value === goldView;
      option.addEventListener('change', () => {
        if (!option.checked) return;
        goldView = option.value;
        try { localStorage.setItem('goldView', goldView); } catch { /* Session preference still applies. */ }
        renderGold(lastState?.gold, lastState);
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
