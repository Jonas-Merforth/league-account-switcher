import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TeamDamageFeed, decodeTeamChunk, decodeTeamKeyframe, readTeamSession, teamFromKeyframe, teamFromMatch,
  teamTotalsAt } from './damageTeam.js';
import { DamageRecorder } from './damageRecorder.js';
import { DamageLive } from './damageLive.js';

const heroStatsTable = Buffer.from('030bf2fae2ead2da434b333b232b131b828a727a626a525ac2cab2baa2aa929a020af1f9e1e9d1d9424a323a222a121a8189717961695159c1c9b1b9a1a99199050df4fce4ecd4dc454d353d252d151d848c747c646c545cc4ccb4bca4ac949c040cf3fbe3ebd3db444c343c242c141c838b737b636b535bc3cbb3bba3ab939b070ff6fee6eed6de474f373f272f171f868e767e666e565ec6ceb6bea6ae969e060ef5fde5edd5dd464e363e262e161e858d757d656d555dc5cdb5bda5ad959d0109f0f8e0e8d0d841493139212911198088707860685058c0c8b0b8a0a890980008f7ffe7efd7df4048303820281018878f777f676f575fc7cfb7bfa7af979f', 'hex');
const encode = Buffer.alloc(256);
heroStatsTable.forEach((decoded, encoded) => { encode[decoded] = encoded; });

// Spectator-form type 664 payload: flags, length and the encoded stat vector.
function heroStats({ team, champions = 0, all = champions * 3, taken = 0, kda = [0, 0, 0] }) {
  const vector = Buffer.alloc(1260);
  vector.writeUInt32LE(team, 0x20);
  kda.forEach((value, index) => vector.writeUInt32LE(value, 0x4c + index * 4));
  for (const [offset, total] of [[0x1d0, all], [0x1e0, champions], [0x1f0, taken]]) {
    vector.writeFloatLE(total, offset);
    vector.writeFloatLE(total * 0.75, offset + 4);
    vector.writeFloatLE(total * 0.25, offset + 8);
  }
  const encoded = Buffer.alloc(vector.length);
  for (let i = 0; i < vector.length; i++) encoded[i] = encode[vector[i % 2 ? vector.length - 1 - (i >>> 1) : i >>> 1]];
  return Buffer.concat([Buffer.from([0xe1, encode[0xec], encode[0x09]]), encoded]);
}

function block({ timestamp, packetId, param, payload }) {
  const header = Buffer.alloc(15);
  header.writeFloatLE(timestamp, 1);
  header.writeUInt32LE(payload.length, 5);
  header.writeUInt16LE(packetId, 9);
  header.writeUInt32LE(param, 11);
  return Buffer.concat([header, payload]);
}

const BASE = 0x4000003d;
const DAMAGE = [9000, 12000, 7000, 3000, 15000, 10000, 8000, 11000, 6000, 4000];
function keyframe({ timestamp = 720.25, packetId = 664, damage = DAMAGE } = {}) {
  return Buffer.concat([
    block({ timestamp, packetId: 43, param: BASE, payload: Buffer.alloc(40, 1) }),
    ...damage.map((champions, index) => block({ timestamp, packetId, param: BASE + index,
      payload: heroStats({ team: index < 5 ? 100 : 200, champions, taken: champions / 2, kda: [index, 1, 2] }) }))
  ]);
}

const CHAMPIONS = ['Caitlyn', 'Sona', 'Mel', 'Yunara', 'Viktor', 'Jinx', 'Zyra', 'Bard', 'Akali', 'Morgana'];
const ROSTER = CHAMPIONS.map((championName, index) => ({ riotId: `Player${index}#EUW`, championName,
  rawChampionName: `game_character_displayname_${championName}`, team: index < 5 ? 'ORDER' : 'CHAOS' }));

test('reads the game and platform for the spectator feed from the game log', () => {
  const log = '000000.244| ALWAYS|   CFG| Command Line:  "1.2.3.4 7163 a2V5 32810" "-Product=LoL" "-GameID=8048482196" "-Region=EUW" "-PlatformID=EUW1" "-Locale=en_US"\r\n';
  assert.deepEqual(readTeamSession(log), { gameId: '8048482196', platformId: 'EUW1' });
  assert.equal(readTeamSession('GameStartData::GameID=8048482196\r\n'), null);
});

test('decodes every hero stat block in a spectator keyframe', () => {
  const frame = decodeTeamKeyframe(keyframe());
  assert.equal(frame.gameTime, 720.25);
  assert.equal(frame.heroes.size, 10);
  assert.deepEqual(frame.heroes.get(BASE + 6).damageToChampions, { total: 8000, physical: 6000, magic: 2000, true: 0 });
  assert.equal(frame.heroes.get(BASE + 6).team, 200);
  // Exact-size blocks are read if the packet ID differs in the spectator stream.
  assert.equal(decodeTeamKeyframe(keyframe({ packetId: 700 })).heroes.size, 10);
});

test('names keyframe heroes from the roster and puts the player’s team first', () => {
  const frame = { keyFrameId: 12, ...decodeTeamKeyframe(keyframe()) };
  const view = teamFromKeyframe(frame, { roster: ROSTER, playerId: 'Player6#EUW', gameTime: 900.75 });
  assert.equal(view.identified, true);
  assert.equal(view.behind, 180.5);
  assert.deepEqual(view.teams.map((team) => team.side), ['ally', 'enemy']);
  assert.deepEqual(view.teams[0].players.map((player) => player.name), ['Jinx', 'Zyra', 'Bard', 'Akali', 'Morgana']);
  const me = view.teams[0].players.find((player) => player.you);
  assert.equal(me.name, 'Zyra');
  assert.deepEqual(me.champion, { total: 8000, physical: 6000, magic: 2000, true: 0 });
  assert.equal(me.all.total, 24000);
  assert.equal(me.taken.total, 4000);
  assert.deepEqual([me.kills, me.deaths, me.assists], [6, 1, 2]);

  // Spawn models take priority over roster order.
  const shuffled = [...ROSTER.slice(5), ...ROSTER.slice(0, 5)];
  const models = new Map(CHAMPIONS.map((name, index) => [BASE + index, name.toLowerCase()]));
  const byModel = teamFromKeyframe(frame, { roster: shuffled, playerId: 'Player6#EUW', heroModels: models });
  assert.equal(byModel.teams[0].players.find((player) => player.you).name, 'Zyra');
});

test('leaves heroes unnamed when the roster disagrees with their teams', () => {
  const frame = decodeTeamKeyframe(keyframe());
  const wrong = ROSTER.map((player, index) => ({ ...player, team: index === 0 ? 'CHAOS' : player.team }));
  const view = teamFromKeyframe(frame, { roster: wrong, playerId: 'Player6#EUW' });
  assert.equal(view.identified, false);
  assert.ok(view.teams.flatMap((team) => team.players).every((player) => !player.you && player.name === 'Unidentified champion'));
  // The roster still tells which side is the player's.
  assert.equal(view.teams[0].side, 'ally');
  assert.deepEqual(view.teams[0].players.map((player) => player.team), [200, 200, 200, 200, 200]);
});

test('polls the spectator feed until a keyframe is published', async () => {
  let now = 0;
  let metadata = 404;
  let info = { keyFrameId: 0, chunkId: 1, nextAvailableChunk: 12000 };
  const requests = [];
  const observer = {
    async getMetadata() {
      requests.push('metadata');
      if (metadata === 404) throw Object.assign(new Error('Observer endpoint failed with HTTP 404.'), { statusCode: 404 });
    },
    async getLastChunkInfo() { requests.push('info'); return info; },
    async getKeyFrame(id) { requests.push(`keyframe ${id}`); return keyframe(); },
    async getChunk(id) { requests.push(`chunk ${id}`); return block({ timestamp: 750, packetId: 952, param: BASE, payload: Buffer.alloc(4) }); }
  };
  const frames = [];
  const feed = new TeamDamageFeed({ platformId: 'EUW1', gameId: '1', observer, now: () => now, onKeyframe: (frame) => frames.push(frame) });
  await feed.poll();
  assert.equal(feed.state, 'waiting');
  await feed.poll();
  assert.deepEqual(requests, ['metadata']);
  now = 30_000;
  metadata = 200;
  await feed.poll();
  assert.equal(feed.state, 'waiting');
  assert.equal(feed.nextPollAt, 43_000);
  now = 43_000;
  info = { keyFrameId: 3, chunkId: 6, nextAvailableChunk: 1000 };
  await feed.poll();
  assert.equal(feed.state, 'live');
  assert.equal(frames.length, 1);
  assert.equal(feed.latest.keyFrameId, 3);
  now = 60_000;
  await feed.poll();
  assert.equal(requests.filter((request) => request.startsWith('keyframe')).length, 1);
  info = { keyFrameId: 3, chunkId: 7, endGameChunkId: 7 };
  now = 90_000;
  await feed.poll();
  assert.equal(feed.ended, true);
});

test('ignores a keyframe that arrives after the feed was closed', async () => {
  let release;
  const frames = [];
  const observer = { async getMetadata() {}, async getLastChunkInfo() { return { keyFrameId: 2 }; },
    getKeyFrame: () => new Promise((resolve) => { release = () => resolve(keyframe()); }) };
  const feed = new TeamDamageFeed({ observer, onKeyframe: (frame) => frames.push(frame) });
  const pending = feed.poll();
  await new Promise((resolve) => setImmediate(resolve));
  feed.close();
  release();
  await pending;
  assert.equal(frames.length, 0);
  assert.equal(feed.latest, null);
});

test('reports a game the spectator server never publishes as unavailable', async () => {
  let now = 0;
  const observer = { async getMetadata() { throw Object.assign(new Error('HTTP 404'), { statusCode: 404 }); } };
  const feed = new TeamDamageFeed({ observer, now: () => now });
  await feed.poll();
  assert.equal(feed.state, 'waiting');
  now = 7 * 60_000;
  await feed.poll();
  assert.equal(feed.state, 'unavailable');
});

test('keeps an unreadable keyframe once and does not refetch it', async () => {
  const unreadable = [];
  let fetched = 0;
  let now = 0;
  const observer = { async getMetadata() {}, async getLastChunkInfo() { return { keyFrameId: 4 }; },
    async getKeyFrame() { fetched++; return block({ timestamp: 1, packetId: 664, param: BASE, payload: Buffer.alloc(8) }); } };
  const feed = new TeamDamageFeed({ observer, now: () => now, onUnreadable: (id) => unreadable.push(id) });
  await feed.poll();
  now = 60_000;
  await feed.poll();
  assert.equal(feed.state, 'unreadable');
  assert.deepEqual(unreadable, ['keyframe-4']);
  assert.equal(fetched, 1);
});

// Chunk damage rows. The stub decoder reads source, target, amount and type
// from a small test payload; the real 393 decoder has its own tests.
function hitBlock(time, sourceId, targetId, amount, typeCode = 0, packetId = 393) {
  const payload = Buffer.alloc(13);
  payload.writeUInt32LE(sourceId, 0);
  payload.writeUInt32LE(targetId, 4);
  payload.writeFloatLE(amount, 8);
  payload[12] = typeCode;
  return block({ timestamp: time, packetId, param: targetId, payload });
}
const stubHit = (param, payload) => {
  if (payload.length !== 13) throw new RangeError('bad row');
  return { sourceId: payload.readUInt32LE(0), targetId: payload.readUInt32LE(4), amount: payload.readFloatLE(8), typeCode: payload[12] };
};
const MINION = 0x40001000;

function lateRecording(startedAt = 141) {
  const recorder = new DamageRecorder({ captureFactory: () => ({ busy: false }) });
  const live = new DamageLive('unused.pcapng');
  recorder.live = live;
  live.owner = BASE + 6;
  live.wire = { stats: { checked: 1, missing: 0, fragmentLoss: 0 } };
  live.tracker.reset({ gameId: 'live', startedAt });
  live.sample({ gameData: { gameTime: 161 }, allPlayers: ROSTER, activePlayer: ROSTER[6] }, 161000, 161000);
  live.lastServerPacketAt = 161000;
  recorder.teamFeed = new TeamDamageFeed({ observer: {}, decodeHit: stubHit,
    onKeyframe: () => recorder.syncBeforeRecording(), onChunk: () => recorder.syncBeforeRecording() });
  return recorder;
}

test('a late recording fills the gap at the capture start and keeps subsequent hits attributed once', async () => {
  const recorder = lateRecording();
  const { live, teamFeed } = recorder;
  teamFeed.readKeyframe(3, keyframe({ timestamp: 120 }));
  assert.equal(recorder.snapshot('champion').meter, null);
  teamFeed.observer.getChunk = async () => Buffer.concat([
    hitBlock(130, live.owner, BASE, 200, 1), hitBlock(135, live.owner, MINION, 50),
    hitBlock(150, live.owner, BASE, 30)
  ]);
  // The spectator history can establish the start even before a local hit
  // is available, including when there is a gap later in the capture.
  live.wire.stats.missing = 1;
  await teamFeed.readChunks(7);
  const first = recorder.snapshot('champion').meter;
  assert.equal(first.total.beforeRecording, 8200);
  assert.equal(first.total.total, 8200);
  assert.equal(first.total.hits, 0);
  assert.equal(first.gaps, true);
  assert.deepEqual(first.fights, []);
  live.tracker.add({ id: 'captured', time: 150, sourceId: String(live.owner), targetId: BASE,
    targetKind: 'champion', amount: 30, damageType: 'physical', ability: 'Q' });
  teamFeed.readKeyframe(4, keyframe({ timestamp: 155 }));
  recorder.syncBeforeRecording();
  const { meter, dealt } = recorder.snapshot('champion');
  assert.equal(meter.total.beforeRecording, 8200);
  assert.equal(meter.total.total, 8230);
  assert.deepEqual(meter.total.types, { physical: 6030, magic: 2200, true: 0, unknown: 0 });
  assert.equal(meter.total.sources[0].amount, 30);
  assert.equal(meter.total.hits, 1);
  assert.equal(meter.total.duration, 161);
  assert.equal(meter.total.dps, 8230 / 161);
  assert.equal(meter.fights[0].total, 30);
  assert.equal(dealt.total, 30);
  assert.equal(recorder.snapshot('all').meter.total.total, 24280);
  recorder.matchTotals = { champion: { total: 8300, types: { physical: 6100 }, fromMatchHistory: true } };
  const final = recorder.snapshot('champion').matchTotals.champion;
  assert.equal(final.total, 8300);
  assert.equal(final.beforeRecording, 8200);
  assert.equal(final.breakdownTotal, 8230);
  assert.deepEqual(final.sources, meter.total.sources);
});

test('a first spectator frame after recording starts removes the overlap independently for each target and school', () => {
  const recorder = lateRecording();
  const { live, teamFeed } = recorder;
  const add = (id, time, amount, targetId, schools) => live.tracker.add({ id, time, sourceId: String(live.owner),
    targetKind: 'unclassified', targetId, amount, schools });
  add('minion', 143, 45, MINION, { physical: 20, magic: 25 });
  add('champion', 145, 30, BASE, { magic: 30 });
  add('later', 155, 10, BASE, { true: 10 });
  teamFeed.readKeyframe(3, keyframe({ timestamp: 145.1 }));
  assert.equal(live.beforeRecording, null); // A hit at the boundary could be on either side.
  live.reader.remaining = 200;
  teamFeed.readKeyframe(4, keyframe({ timestamp: 150 }));
  assert.equal(live.beforeRecording, null);
  live.reader.remaining = 0;
  live.wire.stats.missing = 1;
  recorder.syncBeforeRecording();
  assert.equal(live.beforeRecording, null);
  live.wire.stats.missing = 0;
  recorder.syncBeforeRecording();
  assert.deepEqual(live.beforeRecording.champion, { total: 7970, physical: 6000, magic: 1970, true: 0 });
  assert.deepEqual(live.beforeRecording.all, { total: 23925, physical: 17980, magic: 5945, true: 0 });
  assert.equal(recorder.snapshot('champion').meter.total.total, 8010);
  assert.equal(recorder.snapshot('all').meter.total.total, 24010);
  const fromStart = lateRecording(0);
  fromStart.teamFeed.readKeyframe(1, keyframe({ timestamp: 2 }));
  assert.equal(fromStart.snapshot('all').meter.total.beforeRecording, undefined);
});

test('reads every damage row in a chunk with its damage school', () => {
  const data = Buffer.concat([
    hitBlock(121, BASE + 6, BASE, 100, 1),
    hitBlock(121, BASE + 6, BASE, 100, 1),
    hitBlock(122, BASE, BASE + 6, 0, 0),
    hitBlock(123, MINION, BASE + 6, 40, 0),
    block({ timestamp: 150, packetId: 952, param: BASE, payload: Buffer.alloc(4) })
  ]);
  const chunk = decodeTeamChunk(data, stubHit);
  assert.equal(chunk.end, 150);
  assert.equal(chunk.rows, 4);
  assert.equal(chunk.rejected, 0);
  // Identical rows are separate hits; zero-damage rows are dropped.
  assert.deepEqual(chunk.hits.map((hit) => [hit.amount, hit.school]), [[100, 'magic'], [100, 'magic'], [40, 'physical']]);
});

test('adds chunk hits after the keyframe to its totals until the first missing chunk', () => {
  const anchor = { keyFrameId: 3, ...decodeTeamKeyframe(keyframe({ timestamp: 120.25 })) };
  const chunks = new Map([
    [7, decodeTeamChunk(Buffer.concat([
      hitBlock(120.2503, BASE + 6, BASE, 999),
      hitBlock(130, BASE + 6, BASE, 100, 1),
      hitBlock(131, BASE + 6, MINION, 50, 0),
      hitBlock(132, MINION, BASE + 6, 25, 2),
      hitBlock(150.25, BASE + 6, BASE + 6, 5, 2)
    ]), stubHit)],
    [8, decodeTeamChunk(hitBlock(170, BASE, BASE + 6, 70, 0), stubHit)],
    [10, decodeTeamChunk(hitBlock(230, BASE + 6, BASE, 1000, 0), stubHit)]
  ]);
  const totals = teamTotalsAt(anchor, chunks);
  assert.equal(totals.chunkId, 8);
  assert.equal(totals.gameTime, 170);
  const zyra = totals.heroes.get(BASE + 6);
  // A hit inside the keyframe's float32 boundary is already counted.
  assert.deepEqual(zyra.damageToChampions, { total: 8105, physical: 6000, magic: 2100, true: 5 });
  assert.equal(zyra.damageDealt.total, 24000 + 155);
  assert.deepEqual(zyra.damageTaken, { total: 4000 + 25 + 5 + 70, physical: 3000 + 70, magic: 1000, true: 30 });
  assert.equal(totals.heroes.get(BASE).damageTaken.total, 4500 + 100);
  // The keyframe totals themselves are not changed.
  assert.equal(anchor.heroes.get(BASE + 6).damageToChampions.total, 8000);
});

test('follows keyframes with 30-second chunks and re-anchors on the next keyframe', async () => {
  let now = 0;
  let info = { keyFrameId: 3, chunkId: 7, nextAvailableChunk: 25_000 };
  const served = new Map([
    [7, Buffer.concat([hitBlock(130, BASE + 6, BASE, 100), hitBlock(150, BASE + 6, BASE, 1)])],
    [8, hitBlock(170, BASE + 6, BASE, 200)],
    [9, hitBlock(190, BASE + 6, BASE, 300)]
  ]);
  const requests = [];
  const observer = {
    async getMetadata() {},
    async getLastChunkInfo() { return info; },
    async getKeyFrame(id) { requests.push(`keyframe ${id}`); return keyframe({ timestamp: 60 * (id - 1) + 0.25 }); },
    async getChunk(id) { requests.push(`chunk ${id}`); return served.get(id) ?? null; }
  };
  const updates = [];
  const feed = new TeamDamageFeed({ observer, now: () => now, decodeHit: stubHit, onChunk: (frame) => updates.push(frame.chunkId) });
  await feed.poll();
  assert.deepEqual(requests, ['keyframe 3', 'chunk 7']);
  assert.equal(feed.latest.chunkId, 7);
  assert.equal(feed.latest.heroes.get(BASE + 6).damageToChampions.total, 8101);
  assert.equal(feed.nextPollAt, 26_000);

  now = 26_000;
  info = { keyFrameId: 3, chunkId: 8, nextAvailableChunk: 29_000 };
  await feed.poll();
  assert.equal(feed.latest.chunkId, 8);
  assert.equal(feed.latest.gameTime, 170);
  assert.equal(feed.latest.heroes.get(BASE + 6).damageToChampions.total, 8301);

  // Keyframe 4 (at 180.25) arrives with chunk 9 and replaces the older chunks.
  now = 56_000;
  info = { keyFrameId: 4, chunkId: 9, nextAvailableChunk: 29_000 };
  await feed.poll();
  assert.deepEqual([...feed.chunks.keys()], [9]);
  assert.equal(feed.latest.keyFrameId, 4);
  assert.equal(feed.latest.heroes.get(BASE + 6).damageToChampions.total, 8300);
  assert.deepEqual(updates, [7, 8, 9]);
});

test('falls back to keyframes when chunk damage rows cannot be read', async () => {
  const unreadable = [];
  const observer = { async getMetadata() {}, async getLastChunkInfo() { return { keyFrameId: 3, chunkId: 8 }; },
    async getKeyFrame() { return keyframe(); },
    async getChunk() { return block({ timestamp: 130, packetId: 393, param: BASE, payload: Buffer.alloc(3) }); } };
  const feed = new TeamDamageFeed({ observer, decodeHit: stubHit, onUnreadable: (label) => unreadable.push(label) });
  await feed.poll();
  assert.equal(feed.state, 'live');
  assert.equal(feed.chunksUnreadable, true);
  assert.deepEqual(unreadable, ['chunk-7']);
  assert.equal(feed.latest.chunkId, null);
  assert.equal(feed.latest.heroes.get(BASE + 6).damageToChampions.total, 8000);
});

test('builds final teams from Match History for every player', () => {
  const match = {
    participantIdentities: ROSTER.map((player, index) => {
      const [gameName, tagLine] = player.riotId.split('#');
      return { participantId: index + 1, player: { gameName, tagLine } };
    }),
    participants: DAMAGE.map((champions, index) => ({ participantId: index + 1, teamId: index < 5 ? 100 : 200, stats: {
      kills: 2, deaths: 1, assists: 3, totalDamageDealtToChampions: champions, physicalDamageDealtToChampions: champions - 100,
      magicDamageDealtToChampions: 100, trueDamageDealtToChampions: 0, totalDamageDealt: champions * 3,
      totalDamageTaken: 500, physicalDamageTaken: 200, magicalDamageTaken: 250, trueDamageTaken: 50 } }))
  };
  const view = teamFromMatch(match, { roster: ROSTER, playerId: 'Player2#EUW' });
  assert.equal(view.source, 'matchHistory');
  assert.equal(view.identified, true);
  assert.deepEqual(view.teams[0].players.map((player) => player.name), CHAMPIONS.slice(0, 5));
  const me = view.teams[0].players.find((player) => player.you);
  assert.equal(me.name, 'Mel');
  assert.deepEqual(me.champion, { total: 7000, physical: 6900, magic: 100, true: 0 });
  assert.deepEqual(me.taken, { total: 500, physical: 200, magic: 250, true: 50 });
  assert.equal(teamFromMatch(match, { roster: ROSTER, playerId: 'Nobody#EUW' }), null);

  const missing = { ...match, participantIdentities: match.participantIdentities.filter(({ participantId }) =>
    ![2, 7].includes(participantId)) };
  const repaired = teamFromMatch(missing, { roster: ROSTER, playerId: 'Player2#EUW' });
  assert.equal(repaired.identified, true);
  assert.deepEqual(repaired.teams.flatMap((group) => group.players.map((player) => player.name)), CHAMPIONS);
  missing.participantIdentities = missing.participantIdentities.filter(({ participantId }) => participantId !== 3);
  const ambiguous = teamFromMatch(missing, { roster: ROSTER, playerId: 'Player0#EUW' });
  assert.equal(ambiguous.identified, false);
  assert.equal(ambiguous.teams[0].players.filter((player) => player.name === 'Unidentified champion').length, 2);
  assert.equal(ambiguous.teams[1].players[1].name, 'Zyra');
});

test('recorder follows the spectator feed and switches to Match History after the game', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damage-team-'));
  const log = path.join(root, 'game_r3dlog.txt');
  fs.writeFileSync(log, 'Build Version: Version 16.23.839.6405\r\n' +
    '000000.244| ALWAYS|   CFG| Command Line:  "-GameID=123" "-PlatformID=EUW1"\r\n' +
    '000001.424| ALWAYS| GameStartData::GameID=123\r\n');
  const startedAt = Date.now();
  let capture;
  let feedOptions;
  let resolveMatch;
  const feed = { state: 'live', latest: null, polls: 0, async poll() { this.polls++; }, close() { this.closed = true; } };
  const recorder = new DamageRecorder({ directory: root, leaguePath: () => root,
    readGame: async () => ({ gameData: { gameTime: 900 }, activePlayer: { riotId: 'Player6#EUW' }, allPlayers: ROSTER }),
    readMatch: () => new Promise((resolve) => { resolveMatch = resolve; }),
    teamFeedFactory: (options) => { feedOptions = options; return feed; },
    captureFactory: ({ onUpdate }) => (capture = { busy: false,
      start() { this.busy = true; onUpdate({ state: 'capturing' }); },
      stop() { this.busy = false; onUpdate({ state: 'complete', gameStartedAt: new Date(startedAt).toISOString() }); }
    }) });
  try {
    recorder.start('next');
    assert.equal(recorder.snapshot().team, null);
    recorder.logSource = log;
    await recorder.poll();
    assert.equal(feedOptions.gameId, '123');
    assert.equal(feedOptions.protocol.heroStats, 313);
    assert.equal(feedOptions.platformId, 'EUW1');
    assert.equal(feed.polls, 1);
    assert.deepEqual(recorder.snapshot().team, { state: 'live', error: null });

    feed.latest = { keyFrameId: 12, ...decodeTeamKeyframe(keyframe()) };
    feedOptions.onKeyframe(feed.latest);
    const live = recorder.snapshot().team;
    assert.equal(live.source, 'spectator');
    assert.equal(live.behind, 900 - 720.25);
    assert.equal(live.teams[0].players.find((player) => player.you).champion.total, 8000);
    const saved = fs.readFileSync(recorder.file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).find((entry) => entry.kind === 'team');
    assert.equal(saved.keyFrameId, 12);
    assert.equal(saved.heroes.length, 10);
    assert.equal(saved.championHits, undefined);
    const hit = { time: 722, sourceId: BASE + 6, targetId: BASE, amount: 123, school: 'magic' };
    const next = { ...feed.latest, chunkId: 25, gameTime: 750 };
    const chunk = { rejected: 0, hits: [hit, hit, { ...hit, targetId: MINION }, { ...hit, targetId: BASE + 7 }] };
    feedOptions.onChunk(next, chunk, feed.latest.gameTime);
    const savedChunk = JSON.parse(fs.readFileSync(recorder.file, 'utf8').trimEnd().split('\n').at(-1));
    assert.equal(savedChunk.hitsFrom, feed.latest.gameTime);
    assert.equal(savedChunk.rejected, 0);
    assert.deepEqual(savedChunk.championHits, Array(2).fill([722, BASE + 6, BASE, 123, 'magic']));
    const compact = new DamageRecorder({ temporaryDirectory: root, captureFactory: () => ({}) });
    compact.file = path.join(root, 'compact-observations.jsonl');
    compact.recordTeamFrame(next, chunk, feed.latest.gameTime);
    assert.equal(fs.existsSync(compact.file), false);

    capture.stop();
    await recorder.poll();
    assert.equal(feed.closed, true);
    resolveMatch({ gameId: 123, gameCreation: startedAt, gameDuration: 1000, gameMode: 'KIWI',
      participantIdentities: ROSTER.map((player, index) => ({ participantId: index + 1,
        player: { gameName: player.riotId.split('#')[0], tagLine: 'EUW' } })),
      participants: DAMAGE.map((champions, index) => ({ participantId: index + 1, teamId: index < 5 ? 100 : 200,
        stats: { totalDamageDealt: champions * 3, totalDamageDealtToChampions: champions + 1000 } })) });
    await new Promise((resolve) => setImmediate(resolve));
    const final = recorder.snapshot().team;
    assert.equal(final.state, 'final');
    assert.equal(final.source, 'matchHistory');
    assert.equal(final.teams[0].players.find((player) => player.you).champion.total, 9000);
  } finally { await recorder.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});
