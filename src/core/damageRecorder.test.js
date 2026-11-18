import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DamageRecorder } from './damageRecorder.js';
import { DamageLive } from './damageLive.js';

test('recorder retains timing and roster without treating snapshots as damage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damage-recorder-'));
  let capture;
  const recorder = new DamageRecorder({ directory: root, leaguePath: () => root,
    readGame: async () => ({ gameData: { gameTime: 42 }, allPlayers: [{ championName: 'Ashe', secret: 'omit' }],
      activePlayer: { riotId: 'tester', secret: 'omit' } }),
    captureFactory: ({ onUpdate }) => (capture = { busy: false,
      start() { this.busy = true; onUpdate({ state: 'waiting' }); },
      stop() { this.busy = false; onUpdate({ state: 'complete' }); }
    }) });
  try {
    recorder.start();
    assert.throws(() => recorder.start(), /previous/);
    await recorder.poll();
    const text = fs.readFileSync(recorder.file, 'utf8');
    assert.equal(text.includes('secret'), false);
    assert.equal(recorder.snapshot().meter, null);
    assert.equal(recorder.snapshot().samples, 1);
    assert.equal(recorder.snapshot().gameTime, 42);
    const oldSession = recorder.sessionDirectory;
    capture.stop(); await recorder.poll();
    assert.ok(fs.existsSync(path.join(oldSession, 'summary.json')));
    recorder.logSource = 'must be reset';
    recorder.start();
    assert.equal(recorder.logSource, null);
    assert.notEqual(recorder.sessionDirectory, oldSession);
  } finally { await recorder.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('saves source names when they change without unrelated game data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damage-names-'));
  let items = [{ itemID: 6653, displayName: "Liandry's Torment", price: 'omit' }];
  const recorder = new DamageRecorder({ directory: root, leaguePath: () => root, readSpellNames: async () => [],
    readGame: async () => ({ gameData: { gameTime: 42 },
      activePlayer: { riotId: 'Me#1', currentGold: 'omit',
        abilities: { Q: { id: 'ZyraQ', displayName: 'Deadly Spines', rawDescription: 'omit' } },
        fullRunes: { keystone: { id: 8021, displayName: 'Fleet Footwork', rawDescription: 'omit' } } },
      allPlayers: [{ riotId: 'Me#1', rawChampionName: 'game_character_displayname_Zyra', items,
        summonerSpells: { summonerSpellOne: { displayName: 'Mark', rawDisplayName: 'GeneratedTip_SummonerSpell_SummonerSnowball_DisplayName' } } }] }),
    captureFactory: ({ onUpdate }) => ({ busy: false,
      start() { this.busy = true; onUpdate({ state: 'waiting' }); },
      stop() { this.busy = false; onUpdate({ state: 'complete' }); } }) });
  try {
    recorder.start();
    await recorder.poll();
    await recorder.poll();
    items = [...items, { itemID: 2503, displayName: 'Blackfire Torch' }];
    await recorder.poll();
    const text = fs.readFileSync(recorder.file, 'utf8');
    assert.equal(text.includes('omit'), false);
    const names = text.trim().split('\n').map((line) => JSON.parse(line)).filter((entry) => entry.kind === 'names');
    assert.equal(names.length, 2);
    assert.deepEqual(names[0].data, {
      abilities: { Q: { id: 'ZyraQ', displayName: 'Deadly Spines' } },
      summonerSpells: { summonerSpellOne: { displayName: 'Mark', rawDisplayName: 'GeneratedTip_SummonerSpell_SummonerSnowball_DisplayName' } },
      items: [{ itemID: 6653, displayName: "Liandry's Torment" }],
      runes: [{ id: 8021, displayName: 'Fleet Footwork' }]
    });
    assert.equal(names[1].data.items.length, 2);
  } finally { await recorder.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('target scope filters every damage interval and flags unidentified hits', () => {
  const recorder = new DamageRecorder({ captureFactory: () => ({ busy: false }) });
  const live = new DamageLive('unused.pcapng');
  recorder.live = live;
  live.wire = { stats: { checked: 1, missing: 0, fragmentLoss: 0, rejected: 0 } };
  live.owner = 1;
  live.lastGameTime = 45;
  live.tracker.reset({ gameId: 'test' });
  const addHit = (time, targetKind, amount, damageType, targetId) => live.tracker.add({
    id: String(time), time, sourceId: '1', targetKind, amount, damageType, targetId
  });

  const waiting = recorder.snapshot('champion');
  assert.equal(waiting.meter, null);
  assert.match(waiting.meterStatus, /Waiting for decoded damage/);
  assert.equal(recorder.snapshot('all').meter.total.total, 0);

  live.heroModels.set(2, 'practicetool_targetdummy');
  addHit(4, 'unclassified', 20, 'physical', 2);
  assert.equal(recorder.snapshot('champion').meter.total.total, 0);

  addHit(5, 'unclassified', 40, 'physical');
  const unavailable = recorder.snapshot('champion');
  assert.equal(unavailable.meter, null);
  assert.match(unavailable.meterStatus, /unidentified/);
  assert.equal(recorder.snapshot('all').meter.total.total, 60);

  live.heroModels.set(3, 'heimerdinger');
  addHit(10, 'unclassified', 100, 'physical', 3);
  addHit(32, 'unclassified', 60, 'magic', 3);
  addHit(39, 'neutral', 15, 'true');
  addHit(44, 'neutral', 15, 'true');
  assert.equal(recorder.snapshot('champion').meter, null);
  live.sample({ gameData: { gameTime: 45 }, allPlayers: [
    { championName: 'Localized display name', rawChampionName: 'game_character_displayname_Heimerdinger' }
  ] }, 0, 0);
  const champions = recorder.snapshot('champion').meter;
  assert.equal(champions.total.total, 160);
  assert.equal(champions.last30.total, 60);
  assert.equal(champions.fights.at(-1).total, 60);
  assert.equal(champions.fights.at(-1).types.magic, 60);
  assert.equal(champions.fights.at(-1).active, false);
  // Every roster champion has a known object, so the unknown target is not one.
  assert.equal(champions.gaps, false);

  const all = recorder.snapshot('all').meter;
  assert.equal(all.total.total, 250);
  assert.equal(all.last30.total, 90);
  assert.deepEqual(all.fights, champions.fights);
  assert.equal(all.gaps, false);

  addHit(46, 'unclassified', 25, 'physical', 3);
  const nextFight = recorder.snapshot('all').meter.fights.at(-1);
  assert.equal(nextFight.start, 46);
  assert.equal(nextFight.total, 25);
  assert.equal(nextFight.active, true);
  recorder.finalized = true;
  assert.equal(recorder.snapshot('all').meter.fights.at(-1).active, false);
});

test('pairs a recap with a local hero update in the same receive burst', () => {
  const recap = Buffer.from('a6986e002e2ebb1e', 'hex'); // 17.25 seconds
  const localUpdate = Buffer.from('d9fa30', 'hex'); // Common object ID 0x400000a1
  const otherUpdate = Buffer.from('a6', 'hex');
  for (const recapFirst of [true, false]) {
    const live = new DamageLive('unused.pcapng');
    live.owner = 0x400000a1;
    live.readDeathRecap(1074, recap, 2000);
    live.readDeathRecap(419, otherUpdate, 2001);
    live.readDeathRecap(419, localUpdate, 2004);
    assert.equal(live.deathRecap, undefined);

    const messages = [[1074, recap], [419, localUpdate]];
    if (!recapFirst) messages.reverse();
    messages.forEach(([type, fields], index) => live.readDeathRecap(type, fields, 3000 + index));
    assert.deepEqual(live.deathRecap, { time: recapFirst ? 3000 : 3001, duration: 17.25,
      schools: { physical: 0, magic: 0, true: 0 }, displayTypes: { physical: 0, magic: 0, true: 0 } });
  }
});

test('finished recordings use the matching local participant’s League damage totals', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damage-match-totals-'));
  const log = path.join(root, 'game_r3dlog.txt');
  fs.writeFileSync(log, '100.000 | ALWAYS| GameStartData::GameID=123\r\n');
  const startedAt = Date.now();
  let resolveMatch;
  let capture;
  const recorder = new DamageRecorder({ directory: root, leaguePath: () => root,
    readGame: async () => ({ gameData: { gameTime: 90 }, activePlayer: { riotId: 'Local#TEST' } }),
    readMatch: (id) => {
      assert.equal(id, '123');
      return new Promise((resolve) => { resolveMatch = resolve; });
    },
    captureFactory: ({ onUpdate }) => (capture = { busy: false,
      start() { this.busy = true; onUpdate({ state: 'capturing' }); },
      stop() { this.busy = false; onUpdate({ state: 'complete', gameStartedAt: new Date(startedAt).toISOString() }); }
    }) });
  try {
    recorder.start();
    recorder.logSource = log;
    await recorder.poll();
    assert.equal(recorder.snapshot().matchTotals, null);
    capture.stop();
    await recorder.poll();
    const match = { gameId: 123, gameCreation: startedAt, gameDuration: 100, gameMode: 'PRACTICETOOL',
      participantIdentities: [{ participantId: 2, player: { gameName: 'Local', tagLine: 'TEST' } }],
      participants: [{ participantId: 1, stats: { totalDamageDealt: 1000 } }, { participantId: 2, stats: {
        totalDamageDealt: 900, totalDamageDealtToChampions: 600, physicalDamageDealtToChampions: 550,
        trueDamageDealtToChampions: 50
      } }] };
    resolveMatch(match);
    await new Promise((resolve) => setImmediate(resolve));
    const totals = recorder.snapshot().matchTotals;
    assert.equal(totals.all.total, 900);
    assert.equal(totals.champion.total, 600);
    assert.equal(totals.champion.dps, 6);
    assert.equal(totals.champion.includesPracticeDummies, true);
    assert.deepEqual(totals.champion.types, { physical: 550, true: 50 });
    assert.equal(JSON.parse(fs.readFileSync(path.join(recorder.sessionDirectory, 'summary.json'), 'utf8')).matchTotals.all.total, 900);

    const previousRecording = recorder.live;
    previousRecording.snapshot = () => ({ meter: { fights: [], total: { total: 600.5,
      types: { physical: 550.25, true: 50.25 }, sources: [{ name: 'Basic attacks', amount: 600.5 }] } } });
    const reconciled = recorder.snapshot('champion').matchTotals.champion;
    assert.deepEqual(reconciled.sources, [{ name: 'Basic attacks', amount: 600.5 }]);
    assert.equal(reconciled.sourcesUnavailable, false);
    const mismatched = recorder.snapshot('all').matchTotals.all;
    assert.deepEqual(mismatched.sources, []);
    assert.equal(mismatched.sourcesUnavailable, true);

    match.gameMode = 'KIWI';
    match.participants[0].stats.playerAugment2 = 1075;
    match.participants[1].stats.playerAugment3 = 1045;
    const localLookup = recorder.refreshMatchTotals({ recording: previousRecording, gameId: '123', playerId: 'Local#TEST', gameStartedAt: startedAt });
    resolveMatch(match);
    await localLookup;
    assert.deepEqual(previousRecording.sourceNames.describe(0x79bcfa4), { kind: 'augment', name: 'Infernal Conduit' });

    const previousLookup = recorder.refreshMatchTotals({ recording: previousRecording, gameId: '123', playerId: 'Local#TEST', gameStartedAt: startedAt });
    recorder.start();
    resolveMatch(match);
    await previousLookup;
    assert.equal(recorder.snapshot().matchTotals, null);
  } finally { await recorder.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('the team card adds the live estimate to the spectator totals and keeps them apart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damage-team-live-'));
  const recorder = new DamageRecorder({ directory: root, leaguePath: () => root, readGame: async () => null,
    captureFactory: ({ onUpdate }) => ({ busy: false, start() { this.busy = true; onUpdate({ state: 'capturing' }); },
      stop() { this.busy = false; onUpdate({ state: 'complete' }); } }),
    teamFeedFactory: () => { throw new Error('No observer in this test'); } });
  const stats = (team, total) => ({ team, kills: 0, deaths: 0, assists: 0,
    damageDealt: { total, physical: total, magic: 0, true: 0 }, damageToChampions: { total, physical: total, magic: 0, true: 0 },
    damageTaken: { total: 0, physical: 0, magic: 0, true: 0 } });
  const frame = { keyFrameId: 2, chunkId: 6, gameTime: 120, heroes: new Map([[0x40000001, stats(100, 1000)],
    [0x40000002, stats(100, 500)], [0x40000003, stats(200, 800)]]) };
  try {
    recorder.start();
    const { live } = recorder;
    recorder.activePlayerId = 'Local#TEST';
    recorder.gameTime = 150;
    recorder.roster = [['Local#TEST', 'Ahri', 'ORDER'], ['Ally#TEST', 'Garen', 'ORDER'], ['Foe#TEST', 'Zed', 'CHAOS']]
      .map(([riotId, championName, team]) => ({ riotId, championName, rawChampionName: `game_character_displayname_${championName}`, team }));
    live.wire = { stats: { checked: 1, missing: 0, fragmentLoss: 0 }, finish() {} };
    live.owner = 0x40000001;
    live.heroModels.set(0x40000001, 'ahri').set(0x40000002, 'garen').set(0x40000003, 'zed');
    live.teamLive.setOwner(live.owner);
    live.setTeamIds(new Map([[0x40000001, 100], [0x40000002, 100], [0x40000003, 200]]));
    recorder.teamFeed = { latest: null, state: 'waiting', close() {}, poll: async () => {} };
    assert.deepEqual(recorder.teamSnapshot(), { state: 'waiting', error: null });

    // A hit before the confirmed totals and one after them.
    const hit = (time, at, healthBefore, healthAfter) => {
      live.teamLive.replication({ time: time + 30, at });
      live.teamLive.health({ id: 0x40000003, health: healthBefore });
      live.teamLive.marker({ owner: 0x40000002, time, champion: true });
      live.teamLive.marker({ owner: 0x40000003, time, champion: true });
      live.teamLive.replication({ time: time + 30.1, at: at + 100 });
      live.teamLive.health({ id: 0x40000003, health: healthAfter });
    };
    hit(100, 1000, 900, 700);
    hit(140, 5000, 700, 640);
    live.teamLive.ownHit({ sourceId: 0x40000001, targetId: 0x40000003, amount: 25, time: 141 });
    live.teamLive.settle();

    // No spectator totals yet: the estimate stands alone, from the start of the recording.
    const alone = recorder.teamSnapshot();
    assert.equal(alone.source, 'live');
    assert.equal(alone.state, 'waiting');
    assert.deepEqual(alone.teams[0].players.map((row) => [row.name, row.champion.total, row.live]), [
      ['Ahri', 0, { champion: 25, estimated: 0 }], ['Garen', 0, { champion: 260, estimated: 260 }]]);

    recorder.teamFeed.latest = frame;
    recorder.teamFeed.state = 'live';
    const team = recorder.teamSnapshot();
    assert.equal(team.source, 'spectator');
    assert.equal(team.liveSince, 120);
    assert.equal(team.liveGaps, false);
    assert.equal(team.behind, 30);
    // Confirmed totals are untouched. Only the hit after 120 s is live.
    assert.deepEqual(team.teams[0].players.map((row) => [row.name, row.champion.total, row.live]), [
      ['Ahri', 1000, { champion: 25, estimated: 0 }], ['Garen', 500, { champion: 60, estimated: 60 }]]);
    assert.equal(team.teams[1].players[0].live, undefined);
    live.wire.stats.missing = 1;
    assert.equal(recorder.teamSnapshot().liveGaps, true);

    recorder.matchTeam = { source: 'matchHistory', identified: true, teams: [] };
    assert.deepEqual(recorder.teamSnapshot(), { source: 'matchHistory', identified: true, teams: [], state: 'final' });
  } finally { await recorder.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});
