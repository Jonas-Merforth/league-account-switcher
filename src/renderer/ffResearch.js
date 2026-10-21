const $ = (id) => document.getElementById(id);
const SOURCES = [
  ['live', 'Live game events'], ['snapshot', 'Game snapshots'], ['lcu-events', 'Client event stream'],
  ['lcu', 'Client game phase'], ['lcu-session', 'Match metadata'], ['game-log', 'Game logs'],
  ['game-schema', 'Game API schema'], ['lcu-schema', 'Client API schema'],
  ['game-help', 'Game function / event discovery'], ['lcu-help', 'Client function / event discovery'],
  ['lcu-extra-events', 'Additional client buses'], ['network-log', 'Network counters (not packets)'],
  ['packets', 'Windows packet capture'], ['chat-system', 'System chat alignment']
];
const STAGES = { 'vote-start': 'VOTE START', 'vote-progress': 'VOTING', 'vote-failed': 'VOTE FAILED',
  'surrender-accepted': 'ACCEPTED · LATER', 'game-end': 'GAME END · LATER', unknown: 'UNCLASSIFIED', note: 'NOTE' };
const make = (tag, className, text) => {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export async function initFFResearch(api) {
  let state; let timelineKey = ''; let busy = false; let exporting = false;
  const setup = ['ffLabel', 'ffPatch', 'ffInterval', 'ffLogs', 'ffHotkeys', 'ffPackets', 'ffChat'];
  function render(next) {
    state = next;
    $('ffBadge').textContent = state.active ? 'Recording' : state.captureId ? 'Stopped' : 'Idle';
    $('ffBadge').classList.toggle('recording', state.active);
    const packetBusy = state.packets && !['off', 'complete', 'error'].includes(state.packets.state);
    $('ffStart').disabled = state.active || busy || packetBusy;
    $('ffStop').disabled = !state.active || busy;
    $('ffExport').disabled = !state.captureId || exporting || packetBusy;
    $('ffMark').disabled = !state.active || busy;
    for (const id of setup) $(id).disabled = state.active || busy;
    const packetStatus = state.sources.packets || state.packets;
    const packetsEnabled = state.captureId ? state.options.packets : $('ffPackets').checked;
    const packetPrefix = state.captureId && !state.active ? 'Last capture · ' : '';
    $('ffPacketStatus').textContent = packetPrefix + (!packetsEnabled
      ? 'REAL PACKETS OFF — only API data and logs are recorded.'
      : packetStatus ? `Real packets: ${packetStatus.state} · ${packetStatus.detail}`
        : 'Real packets enabled. Start capture will request Windows administrator permission.');
    $('ffPacketStatus').classList.toggle('error', !packetsEnabled || packetStatus?.state === 'error');
    $('ffCaptureStatus').textContent = state.captureId
      ? `${state.active ? 'Recording' : 'Saved'} · ${state.recordCount} records · ${(state.bytes / 1024).toFixed(0)} KB · match ${state.matchIndex || '—'} · game ${state.gameTime === null ? '—' : `${state.gameTime.toFixed(1)} s`}`
      : 'Observation only · no votes or chat sent.';
    $('ffCaptureStatus').title = state.filePath || '';
    $('ffVerdict').textContent = state.timing.verdict;
    $('ffTiming').textContent = state.timing.observedLeadMs === null
      ? 'Candidates require a controlled test. A passed surrender or game ending is a later event.'
      : `Candidate arrived ${state.timing.observedLeadMs} ms before your acceptance marker. Human reaction delay is included; this does not prove an early server signal.`;
    $('ffLater').textContent = `${state.outcomes?.accepted || 0} acceptance clues · ${state.outcomes?.ended || 0} game-end events · ${state.outcomes?.manualAccepted || 0} acceptance markers. These are separate from an early vote signal.`;
    $('ffHotkeyStatus').textContent = state.active ? (state.hotkeys ? 'Marker hotkeys are active.' : 'Marker hotkeys are off. Use Add marker.') : '';
    const sourceNodes = SOURCES.map(([id, title]) => {
      const source = state.sources[id];
      const node = make('div', 'ff-source');
      node.append(make('strong', '', title));
      node.append(make('span', `ff-source-state ${source?.state === 'connected' ? 'connected' : ''}`, source ? `${source.state}${state.active ? '' : ' (last)'}` : (['game-log', 'network-log'].includes(id) && state.options.logs === false ? 'off' : 'idle')));
      node.append(make('small', '', source ? `${source.detail}${source.latencyMs !== undefined ? ` · ${source.latencyMs} ms request` : ''}` : 'Start a capture to observe.'));
      return node;
    });
    $('ffSources').replaceChildren(...sourceNodes);
    if (state.error) { $('ffMessage').textContent = state.error; $('ffMessage').classList.add('error'); }
    renderTimeline();
  }

  function renderTimeline() {
    const filter = $('ffFilter').value;
    const key = `${state.captureId}:${state.recordCount}:${filter}`;
    if (key === timelineKey) return;
    timelineKey = key;
    const list = $('ffTimeline');
    const scroll = list.scrollTop;
    const open = new Set([...list.querySelectorAll('details[open]')].map((node) => node.dataset.id));
    const rows = state.rows.filter((row) => filter === 'all' || (filter === 'markers' ? row.kind === 'marker'
      : ['marker', 'candidate', 'alignment-candidate', 'status', 'match', 'capture', 'discovery'].includes(row.kind) || row.stage === 'game-end'));
    $('ffRowCount').textContent = `${rows.length} shown from the latest ${state.rows.length} rows. Export includes all ${state.recordCount} saved records.`;
    const nodes = [...rows].reverse().map((row) => {
      const detail = make('details', `ff-row ${row.kind === 'marker' ? 'manual' : ''}`);
      detail.dataset.id = String(row.id); detail.open = open.has(String(row.id));
      const summary = make('summary', '');
      summary.append(make('span', 'ff-row-meta', `+${(row.elapsedMs / 1000).toFixed(3)} s · ${row.source} · ${row.side}`));
      summary.append(make('strong', 'ff-row-label', row.label));
      summary.append(make('span', 'ff-row-stage', `${row.kind === 'marker' ? 'MANUAL · ' : ''}${STAGES[row.stage] || row.stage}${row.historical ? ' · HISTORY / BASELINE' : ''}`));
      detail.append(summary);
      // Payloads are inserted only as text; untrusted API/log contents cannot become HTML.
      const pre = make('pre', '', JSON.stringify(row, null, 2));
      detail.append(pre); return detail;
    });
    list.replaceChildren(...(nodes.length ? nodes : [make('p', 'ff-empty', 'No records in this view yet. Start before entering a game, then leave the recorder running.')]));
    list.scrollTop = scroll;
  }

  async function action(work) {
    busy = true; $('ffMessage').textContent = ''; $('ffMessage').classList.remove('error'); render(state);
    try { const next = await work(); if (next) render(next); }
    catch (error) { $('ffMessage').textContent = error.message; $('ffMessage').classList.add('error'); }
    finally { busy = false; render(state); }
  }
  $('ffStart').addEventListener('click', () => action(async () => {
    const next = await api.startFFResearch({
      intervalMs: Number($('ffInterval').value), logs: $('ffLogs').checked, hotkeys: $('ffHotkeys').checked,
      packets: $('ffPackets').checked, chat: $('ffChat').checked,
      label: $('ffLabel').value, patch: $('ffPatch').value
    });
    $('ffSetup').open = false; return next;
  }));
  $('ffStop').addEventListener('click', () => action(() => api.stopFFResearch()));
  $('ffMark').addEventListener('click', () => action(async () => {
    const time = $('ffObservedTime').value.trim();
    if (time && !/^\d{1,3}:[0-5]\d(?:\.\d{1,3})?$/.test(time)) throw new Error('Use minutes:seconds, for example 8:59.');
    const observedGameTime = time ? Number(time.split(':')[0]) * 60 + Number(time.split(':')[1]) : null;
    const next = await api.markFFResearch({ stage: $('ffStage').value, side: $('ffSide').value, note: $('ffNote').value, observedGameTime });
    $('ffNote').value = ''; $('ffObservedTime').value = ''; return next;
  }));
  $('ffExport').addEventListener('click', async () => {
    exporting = true; render(state);
    try {
      const result = await api.exportFFResearch();
      if (!result.canceled) { $('ffMessage').textContent = `Exported ${(result.bytes / 1024).toFixed(0)} KB to ${result.filePath}${result.packetDirectory ? ` plus packet files in ${result.packetDirectory}` : ''}`; $('ffMessage').classList.remove('error'); }
    } catch (error) { $('ffMessage').textContent = error.message; $('ffMessage').classList.add('error'); }
    finally { exporting = false; render(state); }
  });
  $('ffFolder').addEventListener('click', () => action(async () => { const error = await api.openFFResearchFolder(); if (error) throw new Error(error); }));
  $('ffFilter').addEventListener('change', renderTimeline);
  $('ffPackets').addEventListener('change', () => render(state));
  api.onFFResearch(render);
  render(await api.getFFResearch());
}
