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
  assert.equal(champions.incomplete, true);

  const all = recorder.snapshot('all').meter;
  assert.equal(all.total.total, 250);
  assert.equal(all.last30.total, 90);
  assert.deepEqual(all.fights, champions.fights);
  assert.equal(all.incomplete, false);

  addHit(46, 'unclassified', 25, 'physical', 3);
  const nextFight = recorder.snapshot('all').meter.fights.at(-1);
  assert.equal(nextFight.start, 46);
  assert.equal(nextFight.total, 25);
  assert.equal(nextFight.active, true);
  recorder.finalized = true;
  assert.equal(recorder.snapshot('all').meter.fights.at(-1).active, false);
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
    const previousLookup = recorder.refreshMatchTotals({ recording: previousRecording, gameId: '123', playerId: 'Local#TEST', gameStartedAt: startedAt });
    recorder.start();
    resolveMatch(match);
    await previousLookup;
    assert.equal(recorder.snapshot().matchTotals, null);
  } finally { await recorder.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});
