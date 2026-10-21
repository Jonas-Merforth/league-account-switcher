import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { classifyFFEvidence, discoverFFRoutes, FF_WORD, findFFFields, researchChanges, sanitizeResearch, summarizeFFTiming } from './ffResearchEvidence.js';
import { connectResearchEvents, EXTRA_RESEARCH_EVENTS, FFGameLogTail, readResearchJson } from './ffResearchSources.js';
import { surrenderSystemMessage } from './ffChatEvidence.js';

const MARKER_STAGES = ['vote-start', 'vote-progress', 'vote-failed', 'surrender-accepted', 'game-end', 'note'];
const MAX_BYTES = 256 * 1024 * 1024;
const failureCode = (error) => /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'UNAVAILABLE';

export class FFResearchService {
  constructor({ getLeaguePath, getOutputDir, getCredentials, onUpdate = () => {}, readJson = readResearchJson,
    connectEvents = connectResearchEvents, logTail = new FFGameLogTail(getLeaguePath),
    mono = () => performance.now(), wall = () => Date.now(), schedule = true, metadata = {}, packetCapture = null }) {
    Object.assign(this, { getLeaguePath, getOutputDir, getCredentials, onUpdate, readJson, connectEvents, logTail, mono, wall, schedule, metadata });
    this.packetCapture = packetCapture;
    this.epoch = 0; this.active = false; this.timers = new Set(); this.rows = []; this.signals = [];
    this.sources = {}; this.captureId = null; this.filePath = null; this.error = ''; this.matchIndex = 0;
    this.sequence = 0; this.bytes = 0; this.hotkeys = false;
    this.options = { intervalMs: 250, logs: true };
    this.outcomes = { accepted: 0, ended: 0, manualAccepted: 0 };
  }

  start(options = {}) {
    if (this.active) return this.snapshot();
    if (this.packetCapture?.busy) throw new Error('Wait for the previous packet capture to finish converting.');
    const stamp = new Date(this.wall()).toISOString().replace(/[:.]/g, '-');
    const captureId = `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
    const outputDir = this.getOutputDir();
    fs.mkdirSync(outputDir, { recursive: true });
    const filePath = path.join(outputDir, `ff-${captureId}.jsonl`);
    fs.writeFileSync(filePath, '', { flag: 'wx' });
    // Keep the previous capture exportable if creating the next one fails.
    this.captureId = captureId; this.filePath = filePath; this.epoch += 1;
    this.options = { intervalMs: [250, 500, 1000].includes(options.intervalMs) ? options.intervalMs : 250, logs: options.logs !== false,
      packets: options.packets === true, chat: options.chat !== false };
    this.active = true; this.startedAt = new Date(this.wall()).toISOString(); this.startedMono = this.mono();
    this.rows = []; this.signals = []; this.sequence = 0; this.bytes = 0; this.error = ''; this.sources = {};
    this.matchIndex = 0; this.localTeam = null; this.gameTime = null; this.lastGameTime = null;
    this.outcomes = { accepted: 0, ended: 0, manualAccepted: 0 }; this.matchIdAssigned = false;
    this.lastEventId = -1; this.seenEvents = new Map(); this.eventBaseline = true; this.previousEventPoll = null;
    this.previousSnapshot = null;
    this.gameId = null; this.nextSessionTry = 0; this.lcuInventory = new Map(); this.nextInventoryAt = 0;
    this.nextHealthAt = 0;
    this.fields = new Map(); this.fieldBaselines = new Set(); this.phase = null; this.lcuIdentity = null; this.lcuSchemaRead = false;
    this.gameSchemaRead = false; this.nextGameSchemaTry = 0; this.nextLcuSchemaTry = 0;
    this.gameHelpRead = false; this.nextGameHelpTry = 0;
    this.lcuHelpRead = false; this.nextLcuHelpTry = 0; this.extraEvents = [];
    this.socket = null; this.nextSocketTry = 0; this.logTail.reset();
    this.chatSeen = new Set(); this.chatBaselines = new Set(); this.chatIdentity = null;
    this.abort = new AbortController();
    this._record({ kind: 'capture', source: 'recorder', label: 'Capture started', data: {
      formatVersion: 3, options: this.options, environment: this.metadata, label: String(options.label || '').slice(0, 200),
      reportedPatch: String(options.patch || '').slice(0, 80),
      classification: 'Unverified heuristics; no gameplay actions',
      timestamps: 'elapsedMs is monotonic arrival time; eventGameTime is source supplied, not interchangeable',
      initialData: 'Initial events and field values are history/baseline, never an early detection',
      privacy: 'Known identity and secret fields are removed. Log lines containing credential keywords are discarded.',
      snapshotFormat: 'snapshot-base contains full sanitized game data except events; snapshot-delta applies set/remove operations at array-of-key paths. Events are recorded separately.',
      networkFormat: 'network-sample contains game-written counters, not packets or a surrender detector; source clocks and arrival clocks are separate.'
    } });
    if (this.options.packets) {
      try {
        if (!this.packetCapture) throw new Error('Packet helper unavailable');
        this.packetCapture.start(this.filePath);
      } catch (error) { this._status('packets', 'error', error.message); }
    }
    if (this.schedule) {
      this._loop(() => this.pollEvents(), () => this.sources.live?.state === 'connected' ? this.options.intervalMs : 2000);
      this._loop(() => this.pollSnapshot(), () => 2000);
      this._loop(() => this.pollLcu(), () => 1000);
      if (this.options.chat) this._loop(() => this.pollChat(), () => 2000);
      if (this.options.logs) this._loop(() => this.pollLogs(), () => 500);
    }
    this._emit();
    return this.snapshot();
  }

  stop(reason = 'Stopped by user', record = true) {
    if (!this.active) return this.snapshot();
    if (record) this._flushInventory();
    if (record) this._record({ kind: 'capture', source: 'recorder', label: reason, data: {
      sources: this.sources, timing: summarizeFFTiming(this.signals, this.matchIndex), error: this.error,
      recordsBeforeStop: this.sequence, bytesBeforeStop: this.bytes
    } });
    this.active = false; this.epoch += 1;
    if (this.options.packets) this.packetCapture?.stop();
    this.abort?.abort(); this.socket?.close(); this.socket = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this._emit();
    return this.snapshot();
  }

  _loop(work, delay) {
    const epoch = this.epoch;
    const tick = async () => {
      if (!this._current(epoch)) return;
      try { await work(); } catch { this.error = 'An observation source failed; see source status.'; }
      if (!this._current(epoch)) return;
      this._emit();
      const timer = setTimeout(() => { this.timers.delete(timer); tick(); }, delay());
      timer.unref?.(); this.timers.add(timer);
    };
    tick();
  }

  _current(epoch) { return this.active && this.epoch === epoch; }
  _emit() { this.onUpdate(this.snapshot()); }

  _record(entry, { sanitizedData = false } = {}) {
    if (!this.active) return null;
    const row = sanitizeResearch({ id: this.sequence + 1, receivedAt: new Date(this.wall()).toISOString(),
      elapsedMs: Math.round(this.mono() - this.startedMono), matchIndex: this.matchIndex,
      gameTime: this.gameTime, gameId: this.matchIdAssigned ? this.gameId : null, stage: 'unknown', side: 'unknown', historical: false, ...entry });
    // Snapshot/delta data was already sanitized at a consistent depth before diffing.
    // Applying a second depth limit inside this envelope could break reconstruction.
    if (sanitizedData) row.data = entry.data;
    const line = `${JSON.stringify(row)}\n`;
    if (this.bytes + Buffer.byteLength(line) > MAX_BYTES) {
      this.error = 'Debug log reached the 256 MB limit. Start a new capture to continue.';
      this.stop('Capture size limit reached', false);
      return null;
    }
    try { fs.appendFileSync(this.filePath, line); this.bytes += Buffer.byteLength(line); }
    catch {
      this.error = 'Capture file could not be written. Recording stopped.';
      // Do not recurse into another write when the disk is full/unavailable.
      this.active = false; this.epoch += 1; this.abort?.abort(); this.socket?.close(); this.socket = null;
      if (this.options.packets) this.packetCapture?.stop();
      for (const timer of this.timers) clearTimeout(timer);
      this.timers.clear(); this._emit(); return null;
    }
    this.sequence += 1;
    if (!row.historical) {
      if (row.stage === 'surrender-accepted') this.outcomes[row.kind === 'marker' ? 'manualAccepted' : 'accepted'] += 1;
      if (row.stage === 'game-end' && row.kind !== 'marker') this.outcomes.ended += 1;
    }
    this.rows.push(row); if (this.rows.length > 2000) this.rows.shift();
    if (['candidate', 'marker'].includes(row.kind)) {
      this.signals.push(row); if (this.signals.length > 2000) this.signals.shift();
    }
    return row;
  }

  _status(source, state, detail, timing = {}) {
    const previous = this.sources[source];
    this.sources[source] = { state, detail, ...timing, samples: (previous?.samples || 0) + (state === 'connected' ? 1 : 0), at: new Date(this.wall()).toISOString() };
    if (previous?.state !== state || previous?.detail !== detail) this._record({ kind: 'status', source, label: `${state}: ${detail}`, data: this.sources[source] });
  }

  _newMatch(reason) {
    this.matchIndex += 1; this.localTeam = null; this.lastGameTime = null; this.gameTime = null;
    this.outcomes = { accepted: 0, ended: 0, manualAccepted: 0 }; this.matchIdAssigned = false;
    this.lastEventId = -1; this.seenEvents.clear(); this.eventBaseline = true; this.fields.clear(); this.fieldBaselines.clear();
    this.gameSchemaRead = false; this.nextGameSchemaTry = 0; this.previousSnapshot = null; this.previousEventPoll = null;
    this.gameHelpRead = false; this.nextGameHelpTry = 0;
    this._record({ kind: 'match', source: 'recorder', label: reason });
  }

  async pollEvents() {
    const epoch = this.epoch; const began = this.mono();
    try {
      const payload = await this.readJson({ endpoint: '/liveclientdata/eventdata', signal: this.abort.signal });
      const received = this.mono();
      if (!this._current(epoch)) return;
      if (!Array.isArray(payload?.Events)) throw Object.assign(new Error(), { code: 'INVALID_EVENT_SHAPE' });
      this._status('live', 'connected', 'Event stream', { latencyMs: Math.round(received - began) });
      this.ingestEvents(payload.Events, { requestStartedMs: Math.round(began - this.startedMono),
        responseReceivedMs: Math.round(received - this.startedMono), previousSuccessfulPollMs: this.previousEventPoll });
      this.previousEventPoll = Math.round(received - this.startedMono);
    } catch (error) {
      if (this._current(epoch)) {
        this.eventBaseline = true;
        this._status('live', 'waiting', failureCode(error), { lastSuccessfulPollMs: this.previousEventPoll });
      }
    } finally {
      if (this._current(epoch) && this.wall() >= this.nextHealthAt) {
        this.nextHealthAt = this.wall() + 5000;
        this._record({ kind: 'health', source: 'recorder', label: 'Source health / polling coverage',
          data: { sources: this.sources, lastSuccessfulEventPollMs: this.previousEventPoll } });
      }
    }
  }

  ingestEvents(events, observationWindow = null) {
    const ids = events.map((event) => Number(event.EventID)).filter(Number.isFinite);
    const maximum = ids.reduce((max, id) => Math.max(max, id), -1);
    if (!this.matchIndex || (maximum >= 0 && maximum < this.lastEventId)) this._newMatch('Live event session began or restarted');
    for (const event of events) {
      const key = JSON.stringify([event.EventID, event.EventName, event.EventTime]);
      const serialized = JSON.stringify(sanitizeResearch(event));
      if (this.seenEvents.get(key) === serialized) continue;
      const revised = this.seenEvents.has(key);
      this.seenEvents.set(key, serialized);
      if (this.seenEvents.size > 20000) this.seenEvents.delete(this.seenEvents.keys().next().value);
      const label = String(event.EventName || 'Unnamed event');
      const evidence = classifyFFEvidence(label, event, this.localTeam);
      this._record({ source: 'live-events', kind: FF_WORD.test(label) ? 'candidate' : 'event', label,
        ...evidence, historical: this.eventBaseline, observationWindow, revised,
        eventGameTime: Number.isFinite(event.EventTime) ? event.EventTime : null, data: event });
    }
    this.lastEventId = Math.max(this.lastEventId, maximum);
    this.eventBaseline = false;
  }

  async pollSnapshot() {
    const epoch = this.epoch;
    const requestedAt = new Date(this.wall()).toISOString();
    const requestedMono = this.mono();
    try {
      const data = await this.readJson({ endpoint: '/liveclientdata/allgamedata', signal: this.abort.signal });
      if (!this._current(epoch)) return;
      const time = data?.gameData?.gameTime;
      if (!Number.isFinite(time)) throw Object.assign(new Error(), { code: 'INVALID_GAME_SHAPE' });
      if (!this.matchIndex || (this.lastGameTime !== null && time < this.lastGameTime - 5)) this._newMatch('Game clock began or reset');
      this.lastGameTime = time; this.gameTime = time;
      const active = data.activePlayer || {};
      const me = (data.allPlayers || []).find((player) =>
        (active.riotId && player.riotId === active.riotId) || (active.summonerName && player.summonerName === active.summonerName));
      this.localTeam = me?.team || null;
      this._status('snapshot', 'connected', 'Full API field scan (2 s)');
      this._record({ kind: 'sample', source: 'live-snapshot', label: 'Game sample', data: {
        clockAnchor: { requestedAt, receivedAt: new Date(this.wall()).toISOString(), requestDurationMs: this.mono() - requestedMono,
          gameTime: time, meaning: 'Game time sampled somewhere in this request window; packet UTC uses the same computer clock' },
        game: data.gameData, localTeam: this.localTeam, playerCount: data.allPlayers?.length || 0,
        topLevelFields: Object.keys(data), activePlayerFields: Object.keys(active), playerFields: Object.keys(data.allPlayers?.[0] || {}),
        sources: this.sources
      } });
      const { events: _events, ...rest } = data;
      const snapshot = sanitizeResearch(rest);
      if (this.previousSnapshot === null) this._record({ kind: 'snapshot-base', source: 'live-snapshot', label: 'Full baseline (redacted)', data: snapshot }, { sanitizedData: true });
      else {
        const changes = researchChanges(this.previousSnapshot, snapshot);
        if (changes.length) this._record({ kind: 'snapshot-delta', source: 'live-snapshot', label: `${changes.length} field changes`, data: { changes } }, { sanitizedData: true });
      }
      this.previousSnapshot = snapshot;
      this._inspectFields('live-snapshot', data);
      if (!this.gameSchemaRead && this.wall() >= this.nextGameSchemaTry) {
        this.nextGameSchemaTry = this.wall() + 30000;
        await this._schema('game-schema', { endpoint: '/swagger/v3/openapi.json' }, epoch);
      }
      if (this._current(epoch) && !this.gameHelpRead && this.wall() >= this.nextGameHelpTry) {
        this.nextGameHelpTry = this.wall() + 30000;
        await this._help('game-help', { endpoint: '/Help', method: 'POST' }, epoch);
      }
    } catch (error) {
      if (this._current(epoch)) {
        this.fieldBaselines.delete('live-snapshot');
        this._status('snapshot', 'waiting', failureCode(error));
      }
    }
  }

  _inspectFields(source, data) {
    const baseline = !this.fieldBaselines.has(source);
    this.fieldBaselines.add(source);
    const found = findFFFields(data);
    const present = new Set();
    for (const item of found) {
      const key = `${source}:${item.field}`; present.add(key);
      const serialized = JSON.stringify(sanitizeResearch(item.value));
      const before = this.fields.get(key);
      if (before === serialized) continue;
      this.fields.set(key, serialized);
      const payload = { value: item.value, team: item.team };
      this._record({ kind: 'candidate', source, label: item.field,
        ...classifyFFEvidence(item.field, payload, this.localTeam), historical: baseline,
        data: { ...payload, previous: before === undefined ? null : JSON.parse(before) } });
    }
    for (const key of this.fields.keys()) if (key.startsWith(`${source}:`) && !present.has(key)) this.fields.delete(key);
  }

  async _schema(source, request, epoch) {
    try {
      const schema = await this.readJson({ ...request, signal: this.abort.signal });
      if (!this._current(epoch)) return;
      if (!schema?.paths) throw Object.assign(new Error(), { code: 'INVALID_SCHEMA' });
      this._record({ kind: 'schema', source, label: 'Runtime API schema (redacted)', data: schema });
      this._record({ kind: 'discovery', source, label: 'API schema inspected (not an observed vote)', data: {
        version: schema.info?.version || null, pathCount: Object.keys(schema.paths).length,
        candidateRoutes: discoverFFRoutes(schema),
        // Preserve field names with their schema location, not unrelated definitions/data.
        candidateFields: findFFFields(schema).map(({ field }) => field)
      } });
      if (source === 'game-schema') this.gameSchemaRead = true; else this.lcuSchemaRead = true;
      this._status(source, 'connected', 'Inspected; candidate routes are not invoked');
    } catch (error) { if (this._current(epoch)) this._status(source, 'waiting', failureCode(error)); }
  }

  async _help(source, request, epoch, identity = null) {
    const current = () => this._current(epoch) && (!identity || this.lcuIdentity === identity);
    try {
      const help = await this.readJson({ ...request, signal: this.abort.signal });
      if (!current()) return;
      if (!help || !['events', 'functions', 'types'].every((key) => help[key] && typeof help[key] === 'object')) {
        throw Object.assign(new Error(), { code: 'INVALID_HELP' });
      }
      // Names only: API discovery is not an observation of a current vote. Never
      // execute the functions discovered here or persist their runtime values.
      const inventory = Object.fromEntries(['events', 'functions', 'types'].map((key) => [key, Object.keys(help[key])]));
      this._record({ kind: 'discovery', source, label: 'Available API functions / events / types (not vote evidence)', data: inventory });
      if (source === 'game-help') this.gameHelpRead = true;
      else {
        this.lcuHelpRead = true;
        this.extraEvents = EXTRA_RESEARCH_EVENTS.filter((name) => Object.hasOwn(help.events, name));
        this._subscribeExtra();
      }
      this._status(source, 'connected', `${inventory.events.length} events; ${inventory.functions.length} functions; ${inventory.types.length} types`);
    } catch (error) { if (current()) this._status(source, 'waiting', failureCode(error)); }
  }

  _subscribeExtra() {
    const added = this.socket?.subscribe?.(this.extraEvents) || [];
    if (added.length) {
      this._status('lcu-extra-events', 'listening', 'Subscriptions requested; waiting for an observed message');
      this._record({ kind: 'discovery', source: 'lcu-extra-events',
        label: 'Additional event subscriptions requested (delivery unverified)', data: { events: added } });
    }
  }

  ingestEnvelope(topic, data) {
    if (!this.extraEvents.includes(topic)) return;
    const key = `bus:${topic}`;
    const item = this.lcuInventory.get(key) || { route: key, count: 0, fields: [] };
    item.count += 1;
    item.fields = data && typeof data === 'object' ? Object.keys(data) : [typeof data];
    this.lcuInventory.set(key, item);
    this._status('lcu-extra-events', 'connected', 'Additional bus messages received; scanning structured fields');
    this._inspectFields(`lcu-bus:${topic}`, data);
  }

  async pollLcu() {
    const epoch = this.epoch;
    let credentials;
    try {
      credentials = this.getCredentials();
      const identity = `${credentials.pid}:${credentials.port}:${credentials.password}`;
      if (this.lcuIdentity !== identity) {
        this.socket?.close(); this.socket = null; this.lcuIdentity = identity;
        for (const key of this.fields.keys()) if (key.startsWith('lcu-events:')) this.fields.delete(key);
        for (const key of this.fieldBaselines) if (key.startsWith('lcu-events:')) this.fieldBaselines.delete(key);
        this.lcuSchemaRead = false; this.nextLcuSchemaTry = 0;
        this.lcuHelpRead = false; this.nextLcuHelpTry = 0; this.extraEvents = [];
        for (const key of this.fieldBaselines) if (key.startsWith('lcu-bus:')) this.fieldBaselines.delete(key);
        for (const key of this.fields.keys()) if (key.startsWith('lcu-bus:')) this.fields.delete(key);
        this.nextSocketTry = 0;
        this._record({ kind: 'status', source: 'lcu', label: 'League client connection changed' });
      }
      if (!this.socket && this.wall() >= this.nextSocketTry) {
        this.nextSocketTry = this.wall() + 5000;
        const isCurrent = () => this._current(epoch) && this.lcuIdentity === identity;
        const socket = this.connectEvents(credentials, {
          onOpen: () => { if (isCurrent()) { this._status('lcu-events', 'connected', 'Subscribed to client events'); this._subscribeExtra(); } },
          onEvent: (event) => { if (isCurrent()) this.ingestLcuEvent(event); },
          onEnvelope: (topic, data) => { if (isCurrent()) this.ingestEnvelope(topic, data); },
          onClose: () => { if (isCurrent() && this.socket === socket) {
            this.socket = null; this._status('lcu-events', 'waiting', 'Disconnected; reconnecting');
            this._status('lcu-extra-events', 'waiting', 'Disconnected; reconnecting');
            for (const key of this.fieldBaselines) if (key.startsWith('lcu-bus:')) this.fieldBaselines.delete(key);
          } },
          onError: () => { if (isCurrent()) this._status('lcu-events', 'waiting', 'Connection failed'); }
        });
        this.socket = socket;
      }
      const phase = await this.readJson({ ...credentials, endpoint: '/lol-gameflow/v1/gameflow-phase', signal: this.abort.signal });
      if (!this._current(epoch)) return;
      this._status('lcu', 'connected', `Phase: ${String(phase)}`);
      this._phase(phase);
      if (this.wall() >= this.nextSessionTry) {
        this.nextSessionTry = this.wall() + 5000;
        try {
          const session = await this.readJson({ ...credentials, endpoint: '/lol-gameflow/v1/session', signal: this.abort.signal });
          if (!this._current(epoch)) return;
          this._session(session);
          this._status('lcu-session', 'connected', 'Match metadata (5 s)');
        } catch (error) { if (this._current(epoch)) this._status('lcu-session', 'waiting', failureCode(error)); }
      }
      if (this.wall() >= this.nextInventoryAt) {
        this.nextInventoryAt = this.wall() + 5000;
        this._flushInventory();
      }
      if (!this.lcuSchemaRead && this.wall() >= this.nextLcuSchemaTry) {
        this.nextLcuSchemaTry = this.wall() + 30000;
        await this._schema('lcu-schema', { ...credentials, endpoint: '/swagger/v2/swagger.json' }, epoch);
      }
      if (this._current(epoch) && !this.lcuHelpRead && this.wall() >= this.nextLcuHelpTry) {
        this.nextLcuHelpTry = this.wall() + 30000;
        await this._help('lcu-help', { ...credentials, endpoint: '/help' }, epoch, identity);
      }
    } catch (error) {
      if (this._current(epoch)) {
        this._status('lcu', 'waiting', failureCode(error));
        if (!credentials) {
          this.socket?.close(); this.socket = null; this.lcuIdentity = null;
          this._status('lcu-events', 'waiting', 'Client credentials unavailable');
          this._status('lcu-extra-events', 'waiting', 'Client credentials unavailable');
        }
      }
    }
  }

  _phase(phase) {
    if (typeof phase !== 'string' || phase === this.phase) return;
    if (phase === 'InProgress' && !this.matchIndex) this._newMatch('League entered a game');
    this.phase = phase;
    this._record({ kind: 'event', source: 'lcu', label: `Gameflow: ${phase}`,
      stage: /PreEndOfGame|EndOfGame|WaitingForStats/.test(phase) ? 'game-end' : 'unknown' });
  }

  _session(session) {
    const id = session?.gameData?.gameId;
    if (id && id !== this.gameId) {
      // An initial ID enriches the current match; a changed ID is a boundary.
      if (!this.matchIndex || (this.gameId && this.matchIdAssigned)) this._newMatch('LCU match ID changed');
      this.gameId = id;
      this.matchIdAssigned = true;
      this._record({ kind: 'match-info', source: 'lcu', label: 'Match metadata', data: {
        gameId: id, queue: session.gameData.queue, map: session.map,
        gameMode: session.gameData.gameMode, gameType: session.gameData.gameType
      } });
    }
  }

  _flushInventory() {
    if (!this.lcuInventory?.size) return;
    const routes = [...this.lcuInventory.values()]; this.lcuInventory.clear();
    this._record({ kind: 'inventory', source: 'lcu-events', label: 'Observed client route inventory', data: { routes } });
  }

  ingestLcuEvent(event) {
    const uri = String(event.uri || '');
    if (this.options.chat && /^\/lol-chat\/v1\/conversations\/[^/]+\/messages(?:\/[^/]+)?$/.test(uri)) {
      for (const message of Array.isArray(event.data) ? event.data : [event.data]) this.ingestChatMessage(message, false);
      return;
    }
    if (uri === '/lol-gameflow/v1/gameflow-phase') { this._phase(event.data); return; }
    // Do not collect chat, auth, account, or unrelated client payloads. Look for FF field
    // names in any allowed route, plus full gameflow/endgame and FF-named payloads.
    if (/token|auth|credential|password|(?:^|[-/])chat(?:[-/]|$)/i.test(uri)) return;
    // Route shapes and counts help identify a missed source without collecting unrelated
    // client/account/chat payloads. Numeric/UUID path segments are normalized.
    const route = uri.replace(/\/[0-9]+(?=\/|$)/g, '/:id').replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, '/:id');
    if (this.lcuInventory.size < 1000 || this.lcuInventory.has(route)) {
      const item = this.lcuInventory.get(route) || { route, count: 0, fields: [] };
      item.count += 1;
      item.fields = event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? Object.keys(event.data) : [];
      this.lcuInventory.set(route, item);
    }
    if (FF_WORD.test(uri)) {
      this._record({ kind: 'candidate', source: 'lcu-events', label: uri,
        ...classifyFFEvidence(uri, event.data || {}, this.localTeam), data: event.data, eventType: event.eventType });
    } else if (/^\/lol-(gameflow|end-of-game)\//.test(uri)) {
      if (uri === '/lol-gameflow/v1/session') this._session(event.data);
      this._record({ kind: 'event', source: 'lcu-events', label: uri, eventType: event.eventType, data: event.data });
      this._inspectFields(`lcu-events:${uri}`, event.data);
    } else this._inspectFields(`lcu-events:${uri}`, event.data);
  }

  pollLogs() {
    try {
      const result = this.logTail.poll(this.wall());
      this._status('game-log', result.fileCount ? 'connected' : 'waiting', `${result.fileCount} log file(s) watched; only appended lines`);
      for (const notice of result.notices) this._record({ kind: 'discovery', source: 'game-log', label: 'Log attachment / rotation', data: notice });
      this._status('network-log', result.networkFileCount ? 'connected' : 'waiting',
        `${result.networkFileCount || 0} counter log(s) watched; roughly 10 s samples, not packet capture`);
      for (const sample of result.network || []) this._record({ kind: 'network-sample', source: 'network-log',
        label: `${sample.format} counters (not vote evidence)`, data: sample });
      for (const item of result.lines) this._record({ kind: 'candidate', source: 'game-log', label: item.line,
        ...classifyFFEvidence(item.line, {}, this.localTeam), data: item });
    } catch (error) { this._status('game-log', 'waiting', failureCode(error)); this._status('network-log', 'waiting', failureCode(error)); }
  }

  ingestChatMessage(message, historical) {
    const data = surrenderSystemMessage(message);
    if (!data) return;
    const key = crypto.createHash('sha256').update(JSON.stringify([message.id, message.timestamp, message.body])).digest('hex');
    if (this.chatSeen.has(key)) return;
    this.chatSeen.add(key);
    if (this.chatSeen.size > 5000) this.chatSeen.delete(this.chatSeen.values().next().value);
    this._record({ kind: 'alignment-candidate', source: 'chat-system', label: data.messageClass,
      stage: data.stage, side: data.side, historical: historical || message.isHistorical === true, data });
  }

  async pollChat() {
    const epoch = this.epoch;
    try {
      const credentials = this.getCredentials();
      const identity = `${credentials.pid}:${credentials.port}`;
      if (identity !== this.chatIdentity) { this.chatBaselines.clear(); this.chatSeen.clear(); this.chatIdentity = identity; }
      const conversations = await this.readJson({ ...credentials, endpoint: '/lol-chat/v1/conversations', signal: this.abort.signal });
      if (!this._current(epoch)) return;
      if (!Array.isArray(conversations)) throw Object.assign(new Error(), { code: 'INVALID_CHAT_SHAPE' });
      let inspected = 0;
      // Exclude direct messages. Inspect only game/lobby rooms, never write messages.
      for (const room of conversations.slice(0, 50)) {
        if (!['customGame', 'championSelect', 'postGame', 'inGame', 'game'].includes(room.type) || !room.id) continue;
        const messages = await this.readJson({ ...credentials, endpoint: `/lol-chat/v1/conversations/${encodeURIComponent(room.id)}/messages`, signal: this.abort.signal });
        if (!this._current(epoch)) return;
        if (!Array.isArray(messages)) continue;
        for (const message of messages) this.ingestChatMessage(message, !this.chatBaselines.has(room.id));
        this.chatBaselines.add(room.id); inspected++;
      }
      this._status('chat-system', 'listening', `${inspected} game rooms scanned; in-game surrender delivery unverified`);
      this._record({ kind: 'inventory', source: 'chat-system', label: 'Chat room types (no player messages)', data: {
        roomTypes: conversations.map((room) => room.type), inspectedRooms: inspected } });
    } catch (error) { if (this._current(epoch)) this._status('chat-system', 'waiting', failureCode(error)); }
  }

  mark({ stage, side, note = '', observedGameTime = null } = {}) {
    if (!this.active) throw new Error('Start a capture before adding a marker.');
    if (!MARKER_STAGES.includes(stage) || !['ally', 'enemy', 'unknown'].includes(side)) throw new Error('Invalid marker.');
    this._record({ kind: 'marker', source: 'manual', stage, side, label: `${side}: ${stage}`,
      data: { note: String(note).slice(0, 300),
        observedGameTime: typeof observedGameTime === 'number' && Number.isFinite(observedGameTime) && observedGameTime >= 0 ? observedGameTime : null,
        meaning: 'Human observation; includes reaction delay, not an automatic detection. Optional observedGameTime is manually transcribed from the game/chat clock.' } });
    this._emit(); return this.snapshot();
  }

  exportCapture(destination) {
    if (!this.filePath) throw new Error('Record a capture before exporting.');
    if (this.options.packets && this.packetCapture?.busy) throw new Error('Stop recording and wait for packet conversion before exporting.');
    if (path.resolve(destination).toLowerCase() === path.resolve(this.filePath).toLowerCase()) throw new Error('Choose a different file from the active capture.');
    // The event loop cannot append between this synchronous copy and its summary snapshot.
    this._flushInventory();
    const packetDirectory = this.options.packets ? this.packetCapture?.export(destination) : null;
    fs.copyFileSync(this.filePath, destination);
    const { rows: _rows, filePath: _file, ...summary } = this.snapshot();
    fs.appendFileSync(destination, `${JSON.stringify({ kind: 'export-summary', exportedAt: new Date(this.wall()).toISOString(),
      data: sanitizeResearch(summary), note: 'Export includes all saved rows, not just the UI window. Capturing may continue after this export.' })}\n`);
    return { filePath: destination, bytes: fs.statSync(destination).size, packetDirectory };
  }

  snapshot() {
    return {
      active: this.active, captureId: this.captureId, startedAt: this.startedAt || null,
      filePath: this.filePath, bytes: this.bytes, recordCount: this.sequence, error: this.error,
      matchIndex: this.matchIndex, gameId: this.matchIdAssigned ? this.gameId : null, gameTime: this.gameTime ?? null, localTeam: this.localTeam,
      options: this.options, hotkeys: this.hotkeys, sources: this.sources, outcomes: this.outcomes,
      packets: this.options.packets ? this.packetCapture?.state : null,
      // Large snapshot payloads stay in the file; IPC only needs compact timeline rows.
      rows: this.rows.slice(-300).map((row) => ['snapshot-base', 'snapshot-delta', 'schema'].includes(row.kind)
        ? { ...row, data: { note: 'Full snapshot data is in the exported capture.' } } : row),
      timing: summarizeFFTiming(this.signals, this.matchIndex)
    };
  }
}
