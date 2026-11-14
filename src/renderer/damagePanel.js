let timer;
let initialized = false;
let pending = false;
let actionError = '';
let targetScope = 'champion';
let metric = 'reported';
let refreshQueued = false;
const get = (id) => document.getElementById(id);
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const recapTime = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1, maximumFractionDigits: 1, roundingMode: 'halfEven', useGrouping: false
});

function renderCard(id, result, fromDeathRecap = false) {
  const card = get(id);
  card.querySelector('strong').textContent = result?.total != null ? number.format(result.total) : '—';
  const source = card.querySelector('.damage-source');
  source.textContent = result?.fromMatchHistory ? 'League Match History' : result?.fromHealth ? 'HP removed' : 'Reported damage';
  if (result?.fromHealth && result.matchedHits !== result.hits) source.textContent = 'HP removed · Partial';
  if (result?.includesPracticeDummies) source.textContent += ' · Includes dummies';
  const rate = card.querySelector('.damage-rate');
  const details = [];
  if (result?.dps != null) details.push(`${number.format(result.dps)} DPS`);
  if (fromDeathRecap) {
    // League rounds the float to hundredths before formatting it to tenths.
    const hundredths = Math.trunc(Math.fround(Math.fround(result.duration * 100) + 0.4999999701976776));
    details.push(`${recapTime.format(Math.fround(hundredths / 100))} s`);
  }
  else if (result?.dps != null || (id === 'damageFight' && result)) details.push(`${number.format(result.duration)} s`);
  if (result?.fromHealth && result.matchedHits !== result.hits) details.push(`${result.matchedHits} of ${result.hits} hits matched`);
  else if (Number.isInteger(result?.hits)) details.push(`${result.hits} ${result.hits === 1 ? 'hit' : 'hits'}`);
  if (result?.active) details.push('active');
  rate.hidden = details.length === 0;
  rate.textContent = details.join(' · ');
  const detail = card.querySelector('.damage-breakdown');
  detail.replaceChildren();
  if (!result) return;
  for (const [label, value] of [
    ['Physical', result.types.physical], ['Magic', result.types.magic], ['True', result.types.true],
    ['Unattributed HP loss', result.unattributed],
    ...result.sources.map(({ name, amount }) => [name, amount])
  ]) {
    if (!value) continue;
    const line = document.createElement('div');
    line.textContent = `${label} · ${number.format(value)}`;
    detail.append(line);
  }
}

function render(state) {
  get('damageRecord').disabled = state.busy;
  get('damageStop').disabled = !state.busy || ['stopping', 'converting'].includes(state.state);
  get('damageFolder').disabled = !state.sessionDirectory;
  get('damageRecordingStatus').textContent = actionError || state.error || state.detail || 'No recording started';
  get('damageRecordingDetails').textContent = state.sessionDirectory
    ? `${state.samples} game snapshots · ${state.originalLogSaved ? 'Matching game log saved' : 'Matching game log not yet saved'}${state.gameTime == null ? '' : ` · Game time ${Math.floor(state.gameTime)}s`}` : '';
  const meter = state.meter;
  get('damageCoverage').textContent = meter
    ? `${meter.targetScope}${meter.incomplete ? ' · Partial coverage' : ''}${meter.missed ? ` · ${meter.missed} missing packets` : ''}`
    : state.meterStatus || 'Start tracking to see your observed damage.';
  const matchTotal = metric === 'reported' || targetScope === 'all' ? state.matchTotals?.[targetScope] : undefined;
  renderCard('damageTotal', matchTotal ?? meter?.total);
  renderFight(meter);
}

function renderFight(meter) {
  const recap = meter?.deathRecap;
  get('damageFightTitle').textContent = recap ? 'Latest fight · Death Recap' : 'Latest champion fight · Estimate';
  renderCard('damageFight', recap ?? meter?.fights.at(-1), Boolean(recap));
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
  catch (error) { get('damageRecordingStatus').textContent = error.message; }
  finally {
    pending = false;
    if (refreshQueued) { refreshQueued = false; void refresh(); }
  }
}
function refreshDamageSelection() {
  get('damageCoverage').textContent = 'Loading damage…';
  renderCard('damageTotal');
  renderFight();
  void refresh();
}
function bind(id, action) {
  get(id).addEventListener('click', async () => {
    get(id).disabled = true;
    actionError = '';
    try { await action(); await refresh(); }
    catch (error) { actionError = error.message; get('damageRecordingStatus').textContent = actionError; }
    finally { if (id === 'damageFolder') get(id).disabled = false; }
  });
}
export function setDamagePanelActive(active) {
  if (!initialized) {
    bind('damageRecord', () => window.api.startDamageRecording());
    bind('damageStop', () => window.api.stopDamageRecording());
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
    const saved = Number(localStorage.getItem('damageFightGap'));
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
    initialized = true;
  }
  clearInterval(timer);
  if (active) { refresh(); timer = setInterval(refresh, 1000); }
}
