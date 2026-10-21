import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { FFResearchService } from '../src/core/ffResearch.js';
import { FFGameLogTail, parseResearchNetworkLine, readResearchJson } from '../src/core/ffResearchSources.js';
import { classifyFFEvidence, discoverFFRoutes, findFFFields, researchChanges, sanitizeResearch, summarizeFFTiming } from '../src/core/ffResearchEvidence.js';

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-research-test-'));
  let clock = 1000;
  const service = new FFResearchService({ getLeaguePath: () => dir, getOutputDir: () => dir,
    getCredentials: () => ({ pid: 1, port: 1234, password: 'never-export-this' }), schedule: false,
    mono: () => clock, wall: () => 1780000000000 + clock, ...overrides });
  t.after(() => { service.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  service.start({ label: 'Controlled test', patch: 'test-build' });
  return { service, dir, advance: (ms) => { clock += ms; }, rows: () => fs.readFileSync(service.filePath, 'utf8').trim().split('\n').map(JSON.parse) };
}
const event = (id, name, extra = {}) => ({ EventID: id, EventName: name, EventTime: id * 10, ...extra });

test('classifies stages conservatively and never infers the enemy from a winner', () => {
  assert.equal(classifyFFEvidence('EnemySurrenderVoteStarted').stage, 'vote-start');
  assert.equal(classifyFFEvidence('SurrenderVoteProgress', { Team: 200 }, 'ORDER').side, 'enemy');
  assert.equal(classifyFFEvidence('SurrenderVoteAccepted', { winningTeam: 100 }, 'ORDER').side, 'unknown');
  assert.equal(classifyFFEvidence('EnemySurrenderVoteFailed').stage, 'vote-failed');
  assert.equal(classifyFFEvidence('EnemySurrenderVoteAccepted').stage, 'surrender-accepted');
  assert.equal(classifyFFEvidence('GameEnd', { winningTeam: 'ORDER' }).stage, 'game-end');
  assert.equal(classifyFFEvidence('enemySurrenderStarted', { value: false }).stage, 'unknown');
  assert.equal(classifyFFEvidence('unknown', null).stage, 'unknown');
  assert.equal(classifyFFEvidence('SurrenderStatus').stage, 'unknown');
});

test('redacts identities and credentials while preserving long arrays needed for reconstruction', () => {
  const clean = sanitizeResearch({ puuid: 'person', summonerName: 'Name', authorization: 'secret',
    data: Array.from({ length: 400 }, (_, i) => ({ value: i })), text: 'Basic abcd1234==', nested: { accessToken: 'no' } });
  assert.equal(clean.puuid, '[removed]'); assert.equal(clean.summonerName, '[removed]');
  assert.equal(clean.authorization, '[removed]'); assert.equal(clean.nested.accessToken, '[removed]');
  assert.equal(clean.data.length, 400); assert.equal(clean.text, '[credential removed]');
});

test('history, duplicate events and revised event payloads retain their meaning', (t) => {
  const { service, advance, rows } = fixture(t);
  const old = event(1, 'EnemySurrenderVoteStarted');
  service.ingestEvents([old]); service.ingestEvents([old]);
  assert.equal(rows().filter((row) => row.label === old.EventName).length, 1);
  assert.equal(rows().find((row) => row.label === old.EventName).historical, true);
  assert.equal(service.snapshot().timing.candidateCount, 0);
  advance(100); service.ingestEvents([old, event(2, 'EnemySurrenderVoteProgress', { yesVotes: 1 })]);
  advance(100); service.ingestEvents([old, event(2, 'EnemySurrenderVoteProgress', { yesVotes: 2 })]);
  assert.equal(rows().at(-1).revised, true);
  assert.equal(service.snapshot().timing.candidateCount, 2);
  service.ingestEvents([event(0, 'GameStart')]);
  assert.equal(service.snapshot().matchIndex, 2);
  assert.equal(service.snapshot().timing.candidateCount, 0);
});

test('manual markers never become detections; acceptance and game end never count as early clues', (t) => {
  const { service, advance } = fixture(t);
  service.ingestEvents([event(0, 'GameStart')]);
  service.mark({ stage: 'vote-start', side: 'enemy' });
  advance(100); service.ingestEvents([event(0, 'GameStart'), event(1, 'EnemySurrenderVoteAccepted'), event(2, 'GameEnd')]);
  advance(100); service.mark({ stage: 'surrender-accepted', side: 'enemy' });
  assert.equal(service.snapshot().timing.candidateCount, 0);
  assert.deepEqual(service.snapshot().outcomes, { accepted: 1, ended: 1, manualAccepted: 1 });
  const sample = [{ id: 1, kind: 'candidate', stage: 'vote-start', side: 'enemy', matchIndex: 1, elapsedMs: 50 },
    { id: 2, kind: 'marker', stage: 'surrender-accepted', side: 'enemy', matchIndex: 1, elapsedMs: 150 }];
  assert.equal(summarizeFFTiming(sample, 1).observedLeadMs, 100);
  assert.equal(summarizeFFTiming(sample.map((row) => ({ ...row, historical: true })), 1).candidateCount, 0);
});

test('full snapshot deltas reconstruct unknown fields and more than 128 changes', async (t) => {
  let data = { gameData: { gameTime: 100, gameMode: 'CLASSIC' }, activePlayer: { summonerName: 'me' },
    allPlayers: [{ summonerName: 'me', team: 'ORDER' }], undocumented: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`field${i}`, i])) };
  let deep = { final: 1 }; for (let i = 0; i < 38; i++) deep = { nested: deep };
  data.deep = deep;
  const { service, rows } = fixture(t, { readJson: async ({ endpoint }) => endpoint.includes('swagger') ? { paths: {} } : structuredClone(data) });
  await service.pollSnapshot();
  data = { ...data, gameData: { ...data.gameData, gameTime: 102 }, undocumented: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`field${i}`, i + 100])) };
  await service.pollSnapshot();
  const saved = rows();
  const result = saved.find((row) => row.kind === 'snapshot-base').data;
  const changes = saved.find((row) => row.kind === 'snapshot-delta').data.changes;
  assert.ok(changes.length > 128);
  for (const change of changes) {
    let parent = result;
    for (const key of change.path.slice(0, -1)) parent = parent[key];
    const last = change.path.at(-1);
    if (change.op === 'remove') delete parent[last]; else parent[last] = change.value;
  }
  assert.deepEqual(result, sanitizeResearch(data));
  assert.equal(service.localTeam, 'ORDER');
  assert.equal(service.snapshot().rows.find((row) => row.kind === 'snapshot-base').data.note, 'Full snapshot data is in the exported capture.');
  assert.deepEqual(researchChanges({ a: 1, b: [1] }, { b: [1, 2] }), [{ op: 'remove', path: ['a'] }, { op: 'set', path: ['b'], value: [1, 2] }]);
});

test('newly appearing FF fields are fresh, initial flags are history, false flags do not trigger', (t) => {
  const { service, rows } = fixture(t);
  service._inspectFields('sample', { team: 'CHAOS', surrenderStarted: false });
  service.localTeam = 'ORDER';
  service._inspectFields('sample', { team: 'CHAOS', surrenderStarted: true });
  assert.equal(rows().at(-1).historical, false); assert.equal(rows().at(-1).side, 'enemy');
  service._inspectFields('empty-first', {});
  service._inspectFields('empty-first', { enemySurrenderStarted: true });
  assert.equal(rows().at(-1).historical, false);
});

test('schema discovery is not a signal or permission to invoke an endpoint', async (t) => {
  const calls = [];
  const schema = { info: { version: 'test' }, paths: { '/surrender': { post: { summary: 'Not a reader' } }, '/votes': { get: {} } } };
  const { service, rows } = fixture(t, { readJson: async (request) => { calls.push(request.endpoint); return schema; } });
  await service._schema('game-schema', { endpoint: '/swagger/v3/openapi.json' }, service.epoch);
  assert.deepEqual(calls, ['/swagger/v3/openapi.json']);
  assert.equal(service.snapshot().timing.candidateCount, 0);
  assert.equal(rows().find((row) => row.kind === 'discovery').stage, 'unknown');
  assert.deepEqual(discoverFFRoutes(schema)[0].methods, ['post']);
});

test('stop invalidates in-flight responses, failures show gaps and the next capture starts clean', async (t) => {
  let resolve; const { service, rows } = fixture(t, { readJson: () => new Promise((done) => { resolve = done; }) });
  const pending = service.pollEvents(); service.stop();
  const length = rows().length; resolve({ Events: [event(1, 'EnemySurrenderVoteStarted')] }); await pending;
  assert.equal(rows().length, length);
  service.start(); assert.equal(service.snapshot().recordCount, 1);
  service.readJson = async () => { throw Object.assign(new Error('secret error text'), { code: 'ECONNREFUSED' }); };
  await service.pollEvents();
  assert.equal(service.sources.live.state, 'waiting');
  assert.ok(rows().some((row) => row.label === 'waiting: ECONNREFUSED'));
});

test('events recovered after a gap are history, never early evidence', async (t) => {
  let failing = false; let payload = [event(0, 'GameStart')];
  const { service, rows } = fixture(t, { readJson: async () => {
    if (failing) throw Object.assign(new Error(), { code: 'TIMEOUT' });
    return { Events: payload };
  } });
  await service.pollEvents(); failing = true; await service.pollEvents();
  failing = false; payload = [...payload, event(1, 'EnemySurrenderVoteStarted')];
  await service.pollEvents();
  assert.equal(rows().find((row) => row.label === 'EnemySurrenderVoteStarted').historical, true);
  assert.equal(service.snapshot().timing.candidateCount, 0);
});

test('LCU reconnect rejects old sockets and only records scoped payloads', async (t) => {
  let pid = 1; const sockets = [];
  const { service, advance, rows } = fixture(t, {
    getCredentials: () => ({ pid, port: 1111, password: 'never-export-this' }),
    connectEvents: (_credentials, callbacks) => { const socket = { closed: false, close() { this.closed = true; }, callbacks }; sockets.push(socket); return socket; },
    readJson: async ({ endpoint }) => endpoint.includes('swagger') ? { paths: {} } : endpoint.endsWith('session') ? { gameData: { gameId: 321 } } : 'InProgress'
  });
  await service.pollLcu(); sockets[0].callbacks.onOpen();
  service.ingestLcuEvent({ uri: '/lol-chat/v1/conversations', data: { text: 'Do not record me' } });
  service.ingestLcuEvent({ uri: '/lol-account/v1/data', data: { private: 'Do not record me' } });
  pid = 2; advance(6000); await service.pollLcu();
  assert.equal(sockets[0].closed, true);
  const before = rows().length;
  sockets[0].callbacks.onEvent({ uri: '/enemy-surrender-start', data: {} });
  assert.equal(rows().length, before);
  sockets[1].callbacks.onEvent({ uri: '/enemy-surrender-start', data: {} });
  assert.equal(rows().at(-1).stage, 'vote-start');
  assert.ok(!JSON.stringify(rows()).includes('Do not record me'));
  assert.ok(!JSON.stringify(rows()).includes('never-export-this'));
  service.ingestLcuEvent({ uri: '/unrecognized-game-plugin/state', data: { enemySurrenderStarted: false, unrelated: 'Do not record me' } });
  service.ingestLcuEvent({ uri: '/unrecognized-game-plugin/state', data: { enemySurrenderStarted: true, unrelated: 'Do not record me' } });
  assert.equal(rows().at(-1).stage, 'vote-start');
  assert.equal(rows().at(-1).historical, false);
  assert.ok(!JSON.stringify(rows()).includes('Do not record me'));
});

test('new event session followed by new LCU ID has only one match boundary', (t) => {
  const { service } = fixture(t);
  service._session({ gameData: { gameId: 1 } });
  service.ingestEvents([event(10, 'GameEnd')]);
  service.ingestEvents([event(0, 'GameStart')]);
  assert.equal(service.snapshot().gameId, null);
  service._session({ gameData: { gameId: 2 } });
  assert.equal(service.matchIndex, 2);
});

test('export includes full disk history beyond UI/ring, summary, versions and markers', (t) => {
  const { service, dir } = fixture(t, { metadata: { recorderVersion: 1, appVersion: 'test-version' } });
  for (let i = 0; i < 2200; i++) service._record({ kind: 'event', source: 'fixture', label: `Record ${i}` });
  service.mark({ stage: 'note', side: 'unknown', note: 'Controlled test ended' });
  const exported = service.exportCapture(path.join(dir, 'shared.jsonl'));
  const lines = fs.readFileSync(exported.filePath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(service.snapshot().rows.length, 300);
  assert.equal(lines.length, service.sequence + 1);
  assert.equal(lines[0].data.environment.appVersion, 'test-version');
  assert.equal(lines[0].data.reportedPatch, 'test-build');
  assert.equal(lines.at(-1).kind, 'export-summary');
  assert.equal(lines.at(-2).kind, 'marker');
  assert.throws(() => service.exportCapture(service.filePath), /different file/);
});

test('size cap and write failure stop cleanly without recursive writes', (t) => {
  const { service } = fixture(t);
  service.bytes = 25 * 1024 * 1024;
  service.mark({ stage: 'note', side: 'unknown' });
  assert.equal(service.active, true, 'The former 25 MB boundary must not stop capture');
  service.bytes = 256 * 1024 * 1024;
  service.mark({ stage: 'note', side: 'unknown' });
  assert.equal(service.active, false); assert.match(service.error, /256 MB/);
  service.start(); service.filePath = path.join(service.filePath, 'nonexistent');
  service.mark({ stage: 'note', side: 'unknown' });
  assert.equal(service.active, false); assert.match(service.error, /could not be written/);
});

test('a failed new capture leaves the previous capture available for export', (t) => {
  const { service, dir } = fixture(t);
  service.stop(); const original = service.filePath;
  service.getOutputDir = () => path.join(original, 'invalid-directory');
  assert.throws(() => service.start());
  assert.equal(service.filePath, original);
  assert.ok(service.exportCapture(path.join(dir, 'previous.jsonl')).bytes > 0);
});

test('log tail skips history, handles split lines/truncation, and discards credential text', (t) => {
  const { dir } = fixture(t);
  const logdir = path.join(dir, 'Logs', 'GameLogs', 'game-1'); fs.mkdirSync(logdir, { recursive: true });
  const logfile = path.join(logdir, 'game_r3dlog.txt');
  fs.writeFileSync(logfile, 'Enemy surrender started OLD\n');
  const tail = new FFGameLogTail(() => dir);
  assert.equal(tail.poll(1000).lines.length, 0);
  fs.appendFileSync(logfile, 'Enemy surrender sta');
  assert.equal(tail.poll(1500).lines.length, 0);
  fs.appendFileSync(logfile, 'rted NEW\nToken SECRET surrender started\n');
  const result = tail.poll(2000);
  assert.equal(result.lines.length, 1); assert.equal(result.lines[0].line, 'Enemy surrender started NEW');
  assert.equal(tail.poll(2500).lines.length, 0);
  fs.writeFileSync(logfile, 'GameEnd\n');
  const rotated = tail.poll(3000);
  assert.equal(rotated.notices[0].truncated, true); assert.equal(rotated.lines[0].line, 'GameEnd');
});

test('HTTP transport allows only GET and the observational Help POST; errors omit response secrets', async (t) => {
  let requestOptions; let status = 200; let body = '{"Events":[]}';
  t.mock.method(https, 'request', (options, callback) => {
    requestOptions = options;
    const req = new EventEmitter();
    req.destroy = (error) => req.emit('error', error);
    req.end = () => {
      const res = new EventEmitter(); res.statusCode = status;
      callback(res); res.emit('data', Buffer.from(body)); res.emit('end');
    };
    return req;
  });
  assert.deepEqual(await readResearchJson({ endpoint: '/liveclientdata/eventdata' }), { Events: [] });
  assert.equal(requestOptions.hostname, '127.0.0.1'); assert.equal(requestOptions.method, 'GET');
  assert.equal(requestOptions.port, 2999); assert.equal(requestOptions.headers.Authorization, undefined);
  await readResearchJson({ endpoint: '/Help', method: 'POST' });
  assert.equal(requestOptions.method, 'POST');
  await assert.rejects(readResearchJson({ endpoint: '/Exit', method: 'POST' }), { code: 'METHOD_BLOCKED' });
  status = 403; body = 'VERY_SECRET_RESPONSE';
  await assert.rejects(readResearchJson({ endpoint: '/read', password: 'test' }), (error) => error.code === 'HTTP_403' && !error.message.includes(body));
  assert.equal(requestOptions.headers.Authorization, `Basic ${Buffer.from('riot:test').toString('base64')}`);
  status = 200;
  await assert.rejects(readResearchJson({ endpoint: '/read', maxBytes: 1 }), { code: 'RESPONSE_LIMIT' });
});

test('embedded JSON and named event types are inspected without treating ordinary text as votes', () => {
  const fields = findFFFields({ payload: JSON.stringify({ teamId: 200, eventName: 'SurrenderVoteStarted', surrenderVotes: 2,
    summonerName: 'SurrenderVoteStarted', token: '{"enemySurrenderStarted":true}' }), text: 'please ff now' });
  assert.equal(fields.length, 2);
  assert.equal(fields[0].team, 'CHAOS');
  assert.equal(classifyFFEvidence(fields[0].field, { team: fields[0].team }, 'ORDER').stage, 'vote-start');
  assert.equal(findFFFields({ payload: '{invalid json' }).length, 0);
  assert.equal(findFFFields({ payload: ' '.repeat(65536) + '{"surrender":true}' }).length, 0);
  assert.equal(classifyFFEvidence('Game ended normally').side, 'unknown');
  assert.equal(classifyFFEvidence('AllySurrenderStarted').side, 'ally');
  assert.equal(sanitizeResearch({ Acer: 'Identity' }).Acer, '[removed]');
});

test('Help discovery survives schema 404 and subscribes only to reviewed advertised buses', async (t) => {
  const subscriptions = [];
  const { service, rows } = fixture(t, {
    connectEvents: () => ({ close() {}, subscribe(names) { subscriptions.push(...names); return names; } }),
    readJson: async ({ endpoint }) => {
      if (endpoint === '/help') return { events: { OnLcdsEvent: '', OnLog: '', OnServiceProxyAsyncEvent: '', UnknownAction: '' },
        functions: { SurrenderVoteFunction: '' }, types: {} };
      if (endpoint.includes('swagger')) throw Object.assign(new Error(), { code: 'HTTP_404' });
      if (endpoint.includes('gameflow-phase')) return 'InProgress';
      return { gameData: { gameId: 123 } };
    }
  });
  await service.pollLcu();
  assert.equal(service.sources['lcu-help'].state, 'connected');
  assert.deepEqual(subscriptions, ['OnLcdsEvent', 'OnServiceProxyAsyncEvent']);
  assert.equal(rows().filter(r => r.kind === 'candidate').length, 0);
  service.ingestEnvelope('OnLog', { surrender: true });
  service.ingestEnvelope('OnLcdsEvent', { payload: '{}' });
  service.localTeam = 'ORDER';
  service.ingestEnvelope('OnLcdsEvent', { payload: '{"teamId":200,"enemySurrenderStarted":true}', unrelated: 'PRIVATE' });
  assert.equal(rows().at(-1).stage, 'vote-start');
  assert.equal(rows().at(-1).historical, false);
  assert.ok(!JSON.stringify(rows()).includes('PRIVATE'));
});

test('Help response after stop is ignored and game Help is rediscovered for each match', async (t) => {
  let finish;
  const { service, rows } = fixture(t, { readJson: () => new Promise(resolve => { finish = resolve; }) });
  const promise = service._help('game-help', { endpoint: '/Help', method: 'POST' }, service.epoch);
  service.stop(); finish({ events: {}, functions: {}, types: {} }); await promise;
  assert.ok(!rows().some(r => r.source === 'game-help'));
  service.start(); service.readJson = async () => ({ events: {}, functions: {}, types: {} });
  await service._help('game-help', {}, service.epoch);
  assert.equal(service.gameHelpRead, true);
  service._newMatch('test'); assert.equal(service.gameHelpRead, false);
});

test('network parsers preserve clocks and counters without exporting addresses or identity', () => {
  const columns = ['game.time', 'stats.duration', 'network.bytes_received', 'network.peer_address', 'player.id', ''];
  const sample = parseResearchNetworkLine('539.9,10.0,130778,192.0.2.1,123456,', columns);
  assert.deepEqual(sample.counters, { 'game.time': 539.9, 'stats.duration': 10, 'network.bytes_received': 130778 });
  assert.equal(sample.sourceGameTime, 539.9);
  assert.equal(parseResearchNetworkLine('539,10', columns), null);
  assert.equal(parseResearchNetworkLine('NaN,10,5,192.0.2.1,123,', columns), null);
  const values = Array(24).fill('1'); values[0] = '600000'; values[1] = '192.0.2.1';
  const net = parseResearchNetworkLine(values.join(','));
  assert.equal(net.counters.logTimeMs, 600000);
  assert.ok(!JSON.stringify(net).includes('192.0.2.1'));
  assert.equal(parseResearchNetworkLine('header,address,invalid'), null);
});

test('network log tail skips history, handles fragmented rows and rotation, and exports samples without FF candidates', (t) => {
  const { service, dir, rows } = fixture(t);
  const logdir = path.join(dir, 'Logs', 'GameLogs', 'game-1'); fs.mkdirSync(logdir, { recursive: true });
  const file = path.join(logdir, 'game_netstats.csv');
  const header = 'game.frametime_average,game.time,stats.duration,network.bytes_received,network.peer_address,player.id,\n';
  fs.writeFileSync(file, header + '0.01,100,10,1000,192.0.2.1,123,\n');
  service.pollLogs();
  assert.equal(rows().filter(r => r.kind === 'network-sample').length, 0);
  fs.appendFileSync(file, '0.01,110,10,200'); service.pollLogs();
  assert.equal(rows().filter(r => r.kind === 'network-sample').length, 0);
  fs.appendFileSync(file, '0,192.0.2.1,123,\n'); service.pollLogs();
  const sample = rows().find(r => r.kind === 'network-sample');
  assert.equal(sample.stage, 'unknown'); assert.equal(sample.data.counters['network.bytes_received'], 2000);
  assert.ok(!JSON.stringify(rows()).includes('192.0.2.1'));
  service.pollLogs(); assert.equal(rows().filter(r => r.kind === 'network-sample').length, 1);
  fs.writeFileSync(file, header + '0.01,0,10,1,192.0.2.1,123,\n'); service.pollLogs();
  assert.equal(rows().filter(r => r.kind === 'network-sample').length, 2);
});

test('chat routes are excluded even when their payload contains vote-like fields', (t) => {
  const { service, rows } = fixture(t);
  for (const uri of ['/chat/v5/messages', '/lol-game-client-chat/v2/instant-messages', '/lol-chat/v1/conversations']) {
    service.ingestLcuEvent({ uri, data: { enemySurrenderStarted: true } });
  }
  assert.equal(rows().filter(r => r.kind === 'candidate').length, 0);
});

test('attaching mid-line cannot turn a historical suffix into fresh evidence', (t) => {
  const { dir } = fixture(t);
  const logdir = path.join(dir, 'Logs', 'GameLogs', 'game-1'); fs.mkdirSync(logdir, { recursive: true });
  const file = path.join(logdir, 'game_r3dlog.txt'); fs.writeFileSync(file, 'Historical prefix ');
  const tail = new FFGameLogTail(() => dir); tail.poll(1000);
  fs.appendFileSync(file, 'Enemy surrender started\nEnemy surrender failed\n');
  assert.deepEqual(tail.poll(1500).lines.map(item => item.line), ['Enemy surrender failed']);
});
