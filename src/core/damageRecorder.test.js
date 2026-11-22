import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DamageRecorder } from './damageRecorder.js';
import { DamageLive } from './damageLive.js';
import { pruneStaleCaptures } from './damageTemporaryFiles.js';

test('recorder retains timing and roster without treating snapshots as damage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damage-recorder-'));
  let capture;
  const recorder = new DamageRecorder({ directory: root, leaguePath: () => root,
    readGame: async () => ({ gameData: { gameTime: 42 }, allPlayers: [{ championName: 'Ashe', secret: 'omit' }],
      activePlayer: { riotId: 'tester', secret: 'omit' } }),
    captureFactory: ({ onUpdate }) => (capture = { busy: false,
      start() { this.busy = true; onUpdate({ state: 'capturing' }); },
      stop() { this.busy = false; onUpdate({ state: 'complete' }); }
    }) });
  try {
    recorder.start('next');
    assert.equal(recorder.status('champion').continuous, false);
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
    recorder.start('next');
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
      start() { this.busy = true; onUpdate({ state: 'capturing' }); },
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
    recorder.start('next');
    recorder.logSource = log;
    await recorder.poll();
    const previousRecording = recorder.live;
    previousRecording.snapshot = (scope) => scope === 'champion' ? ({ meter: { fights: [], total: { total: 600.5,
      types: { physical: 550.25, true: 50.25 }, sources: [{ name: 'Basic attacks', amount: 600.5 }] } } }) : null;
    assert.equal(recorder.snapshot().matchTotals, null);
    capture.stop();
    await recorder.poll();
    const match = { gameId: 123, gameCreation: startedAt, gameDuration: 100, gameMode: 'PRACTICETOOL',
      participantIdentities: [{ participantId: 2, player: { gameName: 'Local', tagLine: 'TEST' } }],
      participants: [{ participantId: 1, stats: { totalDamageDealt: 1000 } }, { participantId: 2, stats: {
        totalDamageDealt: 900, totalDamageDealtToChampions: 600, physicalDamageDealtToChampions: 550,
        trueDamageDealtToChampions: 50, playerAugment3: 1045
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

    const reconciled = recorder.snapshot('champion').matchTotals.champion;
    assert.deepEqual(reconciled.sources, [{ name: 'Basic attacks', amount: 600.5 }]);
    assert.equal(reconciled.sourcesUnavailable, false);
    const mismatched = recorder.snapshot('all').matchTotals.all;
    assert.deepEqual(mismatched.sources, []);
    assert.equal(mismatched.sourcesUnavailable, true);

    const [saved] = recorder.history.list();
    assert.equal(recorder.history.read(saved.id, 'all').meter, null);
    assert.deepEqual(recorder.history.read(saved.id, 'champion').meter.total.sources, reconciled.sources);
  } finally { await recorder.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('the default mode re-arms and a late final scoreboard updates only its saved game', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damage-always-'));
  const log = path.join(root, 'game_r3dlog.txt');
  fs.writeFileSync(log, 'GameStartData::GameID=123\r\n');
  const startedAt = Date.now();
  const gameStartedAt = new Date(startedAt).toISOString();
  let resolveMatch, capture;
  let gameReads = 0;
  const modes = [];
  const recorder = new DamageRecorder({ directory: root, leaguePath: () => root,
    readGame: async () => {
      gameReads++;
      return { gameData: { gameTime: 600 }, activePlayer: { riotId: 'Local#TEST' },
        allPlayers: [{ riotId: 'Local#TEST', championName: 'Ahri', team: 'ORDER' }] };
    },
    readMatch: () => new Promise((resolve) => { resolveMatch = resolve; }),
    readChampions: async () => [{ id: 103, name: 'Ahri' }, { id: 202, name: 'Jhin' }],
    captureFactory: ({ onUpdate }) => (capture = { busy: false,
      start(_file, { continuous }) { modes.push(continuous); this.busy = true; onUpdate({ state: 'waiting' }); },
      game() { onUpdate({ state: 'capturing', gameStartedAt }); },
      finish() { this.busy = false; onUpdate({ state: 'complete', gameStartedAt }); },
      stop() { this.busy = false; onUpdate({ state: 'complete' }); }
    }) });
  try {
    recorder.start();
    await recorder.poll();
    assert.equal(gameReads, 0);
    capture.game();
    recorder.logSource = log;
    await recorder.poll();
    capture.finish();
    await recorder.poll();

    assert.equal(recorder.status('champion').continuous, true);
    assert.equal(recorder.status('champion').view.gameTime, 600);
    assert.deepEqual(modes, [true, true]);
    const [first] = recorder.history.list();
    assert.equal(first.champion, 'Ahri');
    assert.ok(fs.existsSync(path.join(root, first.id, 'observations.jsonl')));
    assert.ok(fs.existsSync(path.join(root, first.id, 'original-r3dlog.txt')));

    capture.game();
    await recorder.poll();
    resolveMatch({ gameId: 123, gameCreation: startedAt, gameDuration: 610, gameMode: 'KIWI',
      participantIdentities: [{ participantId: 1, player: { riotIdGameName: 'Local', riotIdTagLine: 'test' } }],
      participants: [{ participantId: 1, teamId: 100, championId: 103, stats: {
        totalDamageDealtToChampions: 500, playerAugment3: 1045
      } }, { participantId: 2, teamId: 200, championId: 202, stats: { totalDamageDealtToChampions: 900 } }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recorder.snapshot().matchTotals, null);
    const saved = recorder.status('champion', first.id);
    assert.equal(saved.state, 'capturing');
    assert.equal(saved.view.busy, false);
    assert.equal(saved.view.matchTotals.champion.total, 500);
    assert.deepEqual(saved.view.team.teams.map((team) => team.players[0].name), ['Ahri', 'Jhin']);
    assert.equal(saved.view.team.identified, true);
    capture.finish();
    await recorder.poll();
    assert.equal(recorder.history.list().length, 2);
    recorder.stop();
    await recorder.poll();
    assert.deepEqual(modes, [true, true, true]);
    assert.equal(recorder.history.list().length, 2);
    assert.equal(recorder.status('champion').continuous, false);

    const reopened = new DamageRecorder({ directory: root, captureFactory: () => ({ busy: false }) });
    assert.equal(reopened.history.read(first.id, 'champion').matchTotals.champion.total, 500);
    assert.equal(reopened.history.read('../summary.json'), null);
  } finally { await recorder.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('release tracking retains summaries and lineups through two matches and a helper shutdown', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damage-release-'));
  const directory = path.join(root, 'history');
  const temporaryDirectory = path.join(root, 'capture');
  const log = path.join(root, 'game_r3dlog.txt');
  fs.writeFileSync(log, 'GameStartData::GameID=123\r\n');
  const startedAt = Date.now();
  const gameStartedAt = new Date(startedAt).toISOString();
  const lineup = [{ championName: 'Ahri', team: 'ORDER' }, { championName: 'Jhin', team: 'CHAOS' }];
  let capture, resolveMatch;
  const recorder = new DamageRecorder({ directory, temporaryDirectory, leaguePath: () => root,
    readGame: async () => ({
      gameData: { gameTime: 100 }, activePlayer: { riotId: 'Local#TEST' },
      allPlayers: [{ ...lineup[0], riotId: 'Local#TEST' }, { ...lineup[1], riotId: 'Enemy#TEST' }],
      events: { Events: [{ EventName: 'Private Test Event' }] }
    }),
    readMatch: () => new Promise((resolve) => { resolveMatch = resolve; }),
    captureFactory: ({ onUpdate, onHelperExit }) => (capture = { busy: false,
      start(file) {
        this.directory = path.dirname(file);
        this.controlDirectory ??= this.directory;
        fs.writeFileSync(path.join(this.directory, 'heartbeat'), 'alive');
        this.busy = true;
        onUpdate({ state: 'waiting' });
      },
      game() {
        fs.writeFileSync(path.join(this.directory, 'raw-ipv4.pcapng'), 'test packet data');
        onUpdate({ state: 'capturing', gameStartedAt });
      },
      finish() { this.busy = false; onUpdate({ state: 'complete', gameStartedAt }); },
      stop() {
        this.busy = false;
        this.controlDirectory = null;
        onUpdate({ state: 'complete' });
        onHelperExit();
      }
    }) });
  try {
    recorder.start('always');
    capture.game();
    recorder.logSource = log;
    await recorder.poll();
    recorder.saveUnreadableSpectatorData('keyframe-1', Buffer.from('test fixture'));
    const firstCapture = capture.directory;
    assert.equal(path.dirname(firstCapture), temporaryDirectory);
    assert.deepEqual(fs.readdirSync(firstCapture).sort(), ['heartbeat', 'raw-ipv4.pcapng']);
    const poll = recorder.live.poll.bind(recorder.live);
    recorder.live.poll = (options) => {
      if (options?.final) assert.ok(fs.existsSync(path.join(firstCapture, 'raw-ipv4.pcapng')));
      return poll(options);
    };
    capture.finish();
    await recorder.poll();
    const [first] = recorder.history.list();
    const firstArchive = path.join(directory, first.id);
    assert.deepEqual(fs.readdirSync(firstArchive), ['summary.json']);
    const saved = fs.readFileSync(path.join(firstArchive, 'summary.json'), 'utf8');
    assert.deepEqual(JSON.parse(saved).roster, lineup);
    assert.doesNotMatch(saved, /Local#TEST|Enemy#TEST|Private Test Event/);
    assert.deepEqual(fs.readdirSync(firstCapture), ['heartbeat']);
    assert.equal(recorder.status('champion').view.sessionDirectory, firstArchive);

    capture.game();
    await recorder.poll();
    const secondCapture = capture.directory;
    resolveMatch({ gameId: 123, gameCreation: startedAt, gameDuration: 100,
      participantIdentities: [{ participantId: 1, player: { gameName: 'Local', tagLine: 'TEST' } }],
      participants: [{ participantId: 1, teamId: 100, stats: { totalDamageDealtToChampions: 500 } },
        { participantId: 2, teamId: 200, stats: { totalDamageDealtToChampions: 900 } }] });
    await new Promise((resolve) => setImmediate(resolve));
    const reopened = new DamageRecorder({ directory, temporaryDirectory });
    const view = reopened.history.read(first.id, 'champion');
    assert.equal(view.matchTotals.champion.total, 500);
    assert.equal(view.team.teams[1].players[0].name, 'Jhin');
    assert.equal(view.retainResearch, false);
    const summaryPath = path.join(firstArchive, 'summary.json');
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    summary.team.identified = false;
    summary.team.teams[1].players[0].name = 'Unidentified champion';
    fs.writeFileSync(summaryPath, JSON.stringify(summary));
    const reopenedAgain = new DamageRecorder({ directory, temporaryDirectory });
    assert.equal(reopenedAgain.history.read(first.id, 'all').team.teams[1].players[0].name, 'Jhin');
    capture.finish();
    await recorder.poll();
    assert.equal(fs.existsSync(secondCapture), false);
    assert.equal(recorder.history.list().length, 2);
    recorder.stop();
    await recorder.poll();
    assert.deepEqual(fs.readdirSync(temporaryDirectory), []);
    assert.equal(fs.readdirSync(directory).length, 2);
  } finally { await recorder.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('reconnects keep both recordings under one game and reconcile the replacement process', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damage-reconnect-'));
  const log = path.join(root, 'game_r3dlog.txt');
  const creation = Date.now() - 600_000;
  const match = { gameId: 123, platformId: 'EUW1', gameCreation: creation, gameDuration: 600,
    participantIdentities: [{ participantId: 1, player: { gameName: 'Local', tagLine: 'TEST' } }],
    participants: [{ participantId: 1, stats: { totalDamageDealtToChampions: 520 } }] };
  let processStart = creation, capture;
  const recorder = new DamageRecorder({ directory: root, leaguePath: () => root,
    readMatch: async () => processStart === creation ? null : match,
    readGame: async () => ({ gameData: { gameTime: 500 }, activePlayer: { riotId: 'Local#TEST' } }),
    captureFactory: ({ onUpdate }) => (capture = {
      start() { this.busy = true; onUpdate({ state: 'waiting' }); },
      game() { onUpdate({ state: 'capturing', gameStartedAt: new Date(processStart).toISOString() }); },
      stop() { this.busy = false; onUpdate({ state: 'complete', gameStartedAt: new Date(processStart).toISOString() }); }
    }) });
  async function record(platform, start) {
    fs.writeFileSync(log, `"-GameID=123" "-PlatformID=${platform}"\r\n`);
    processStart = start;
    capture.game();
    recorder.logSource = log;
    await recorder.poll();
    capture.stop();
    await recorder.poll();
    await new Promise(resolve => setImmediate(resolve));
  }
  try {
    recorder.start('always');
    await record('EUW1', creation);
    await record('EUW1', creation + 180_000);
    const [game] = recorder.history.list();
    assert.equal(recorder.history.list().length, 1);
    assert.equal(game.recordings.length, 2);
    assert.equal(game.recordings[0].id, game.id);
    for (const part of game.recordings) assert.equal(recorder.history.read(part.id, 'champion').matchTotals.champion.total, 520);
    assert.equal(recorder.status('champion').viewId, game.id);
    await record('NA1', creation + 200_000);
    const games = recorder.history.list();
    assert.equal(games.length, 2);
    assert.equal(recorder.history.read(games[0].id).matchTotals, null);
    match.gameId = 124;
    match.gameCreation = creation - 86_400_000;
    fs.writeFileSync(log, 'GameStartData::GameID=124\r\n');
    capture.game();
    recorder.logSource = log;
    await recorder.poll();
    capture.stop();
    await recorder.poll();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(recorder.status('champion').view.matchTotals, null);
  } finally { await recorder.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('release startup cleans abandoned captures and preserves fresh or unrelated directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damage-stale-'));
  const stale = path.join(root, '2026-11-21T01-00-00.000Z-11111111');
  const fresh = path.join(root, '2026-11-21T01-01-00.000Z-22222222');
  const unrelated = path.join(root, 'other-folder');
  try {
    for (const directory of [stale, fresh, unrelated]) {
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'heartbeat'), 'alive');
      fs.writeFileSync(path.join(directory, 'raw-ipv4.pcapng'), 'fixture');
    }
    const now = Date.now();
    const past = new Date(now - 120_000);
    for (const directory of [stale, unrelated]) fs.utimesSync(path.join(directory, 'heartbeat'), past, past);
    assert.equal(pruneStaleCaptures(root, now), true);
    assert.equal(fs.existsSync(stale), false);
    assert.ok(fs.existsSync(path.join(fresh, 'raw-ipv4.pcapng')));
    assert.ok(fs.existsSync(path.join(unrelated, 'raw-ipv4.pcapng')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
