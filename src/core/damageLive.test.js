import test from 'node:test';
import assert from 'node:assert/strict';
import { DamageLive } from './damageLive.js';
import { teamFromTakedowns } from './damageTeam.js';

const player = (name, model, riotId = `${name}#1`) => ({ riotId, championName: name, rawChampionName: `game_character_displayname_${model}` });
const sample = (gameTime, players, me = 'Galio#1') => ({ gameData: { gameTime }, activePlayer: { riotId: me }, allPlayers: players });
const roster = [player('Miss Fortune', 'MissFortune'), player('Sion', 'Sion'), player('Galio', 'Galio'), player('Viktor', 'Viktor'), player('Kayle', 'Kayle')];

test('a local champion combat marker opens the fight card without recording damage', () => {
  const live = new DamageLive('unused.pcapng');
  const championMarker = Buffer.from('a5706f1a8181', 'hex');
  const unitMarker = Buffer.from('f573579d4381', 'hex');
  live.wire = { stats: { checked: 1 } };
  live.tracker.reset({ gameId: 'live' });
  live.lastGameTime = 60;
  const receive = (bytes) => live.readTeamLive(live.protocol.marker, bytes, 100000);
  live.setOwner(0x4000003d, false);
  receive(unitMarker);
  receive(championMarker); // A different champion.
  assert.equal(live.snapshot('champion').meter, undefined);
  live.setOwner(0x40000035, false);
  live.lastGameTime = 50;
  receive(championMarker);
  const { meter, dealt, incoming } = live.snapshot('champion');
  assert.equal(meter.fights[0].start, 48.509124755859375);
  assert.equal(meter.fights[0].active, true);
  assert.equal(meter.fights[0].hits, 0);
  assert.deepEqual(meter.fights[0].sources, []);
  assert.deepEqual([meter.total.total, dealt.total, incoming.total], [0, 0, 0]);
  live.setOwner(0x4000003d, true);
  assert.equal(live.snapshot('champion').meter, undefined);
});

test('takedown subtotals retain early packets and include only identified opposing champions', () => {
  const live = new DamageLive('unused.pcapng');
  const rosterWithTeams = roster.map((p, i) => ({ ...p, team: i < 3 ? 'ORDER' : 'CHAOS' }));
  const ids = roster.map((_, i) => 0x40000040 + i);
  const kill = (sourceId, targetId) => live.addTakedown({ takedown: 'finalHit', sourceId, targetId, amount: 40 });
  kill(ids[0], ids[3]);
  kill(ids[0], ids[3]);
  kill(ids[0], ids[1]);
  kill(ids[0], 99);
  live.addTakedown({ takedown: 'assist', sourceId: ids[0], targetId: ids[4], schools: { physical: 6, magic: 15, true: 2 } });
  assert.equal(teamFromTakedowns(live, rosterWithTeams, 'Galio#1'), null);
  live.owner = ids[2];
  live.sample(sample(200, rosterWithTeams), 0, 0);
  assert.deepEqual(teamFromTakedowns(live, rosterWithTeams, 'Galio#1'), [{ side: 'ally', players: [
    { name: 'Miss Fortune', team: 100, you: false, finalHits: 80, physical: 6, magic: 15, true: 2, total: 103 }
  ] }]);
});

test('names champions from the roster order when the opening spawns were missed', () => {
  const live = new DamageLive('unused.pcapng');
  // At game time 0 League lists the local player first. That order is ignored.
  live.sample(sample(0, [roster[2], roster[0], roster[1], roster[3], roster[4]]), 0, 0);
  live.owner = 0x40000041;
  live.inferHeroes();
  assert.equal(live.heroes.size, 0);

  live.sample(sample(200, roster), 0, 0);
  assert.deepEqual([...live.heroes], [[0x4000003f, 'missfortune'], [0x40000040, 'sion'], [0x40000041, 'galio'],
    [0x40000042, 'viktor'], [0x40000043, 'kayle']]);
  assert.equal(live.heroesInferred, true);
  assert.equal(live.heroesKnown, true);
  const named = live.nameParties([
    { id: String(0x40000042), kind: 'champion', amount: 50, hits: 1, types: { magic: 50 } },
    { id: '1073742200', kind: 'unclassified', amount: 30, hits: 2, types: { magic: 30 } },
    { id: '1073742201', kind: 'unclassified', amount: 20, hits: 1, types: { magic: 20 } }
  ], 'Unidentified targets');
  assert.deepEqual(named.map(({ name, amount, hits }) => [name, amount, hits]),
    [['Viktor', 50, 1], ['Minions, turrets & monsters', 50, 3]]);

  // Viego's possession repeats a name. Such samples leave the mapping alone.
  live.sample(sample(300, [roster[0], roster[1], roster[2], roster[3], player('Kayle', 'Viktor', 'Viego#1')]), 0, 0);
  assert.equal(live.heroes.get(0x40000043), 'kayle');
});

test('spawn messages win over the roster and disagreeing rosters are not used', () => {
  const live = new DamageLive('unused.pcapng');
  live.owner = 0x40000041;
  live.heroModels.set(0x40000041, 'galio');
  live.heroModels.set(0x40000042, 'viktor');
  live.sample(sample(5, roster), 0, 0);
  assert.equal(live.heroes.get(0x4000003f), 'missfortune');
  assert.equal(live.heroes.get(0x40000041), 'galio');

  // A roster that would put another champion on a spawned ID is discarded.
  live.heroModels.set(0x40000043, 'zed');
  live.refreshHeroes();
  assert.equal(live.heroes, live.heroModels);
  assert.equal(live.heroesInferred, false);
});

test('a confirmed local champion keeps tracking through actions from temporary objects', () => {
  const live = new DamageLive('unused.pcapng');
  const local = 0x40000041;
  live.observeActionOwner(local);
  live.heroModels.set(local, 'galio');
  live.sample(sample(200, roster), 0, 0);
  live.observeActionOwner(0x400025c1);
  assert.equal(live.owner, local);
  assert.equal(live.ownerVerified, true);
  assert.equal(live.ownerConflict, false);
  assert.equal(live.teamLive.owner, local);
});

test('a late start resolves temporary action IDs against received damage in either order', () => {
  const local = 0x40000041, temporary = 0x400025c1;
  for (const damageFirst of [false, true]) {
    const live = new DamageLive('unused.pcapng');
    live.observeActionOwner(temporary);
    if (damageFirst) live.observeDamageRecipient(local);
    live.observeActionOwner(local);
    if (!damageFirst) live.observeDamageRecipient(local);
    assert.equal(live.owner, local);
    assert.equal(live.ownerConflict, false);
    live.observeActionOwner(temporary + 1);
    assert.equal(live.ownerConflict, false);
    live.observeDamageRecipient(temporary);
    assert.equal(live.ownerConflict, true);
    live.heroModels.set(local, 'galio');
    live.sample(sample(200, roster), 0, 0);
    assert.equal(live.ownerVerified, true);
    assert.equal(live.ownerConflict, false);
  }
});

test('mirrored picks allow spawn verification only for a unique local champion', () => {
  const players = [player('Galio', 'Galio'), player('Sion', 'Sion'), player('Sion', 'Sion', 'Enemy#1')];
  players.forEach((p, i) => { p.team = i < 2 ? 'ORDER' : 'CHAOS'; });
  const base = 0x40000041;
  const live = new DamageLive('unused.pcapng');
  live.heroModels.set(base, 'galio');
  live.sample(sample(2, players), 0, 0);
  assert.equal(live.ownerVerified, true);
  const mirror = new DamageLive('unused.pcapng');
  mirror.heroModels.set(base + 1, 'sion');
  mirror.sample(sample(2, players, 'Enemy#1'), 0, 0);
  assert.equal(mirror.ownerVerified, false);
  mirror.setTeamIds(new Map([[base, 100], [base + 1, 100], [base + 2, 200]]));
  assert.equal(mirror.ownerVerified, true);
  assert.equal(mirror.owner, base + 2);
});

test('confirming a different champion ID clears provisional attribution and flags incomplete coverage', () => {
  const live = new DamageLive('unused.pcapng');
  const local = 0x40000041;
  const other = 0x400025c1;
  live.observeActionOwner(other);
  live.tracker.reset({ gameId: 'live', startedAt: 10 });
  live.tracker.add({ id: 'provisional', time: 12, amount: 40, damageType: 'magic',
    sourceId: String(other), targetKind: 'champion', targetId: 0x40000042 });
  live.deathRecap = { time: 30, duration: 1 };
  live.observeActionOwner(local);
  assert.equal(live.ownerConflict, true);
  assert.match(live.snapshot().detail, /Multiple local player IDs/);

  live.heroModels.set(local, 'galio');
  live.sample(sample(20, roster), 0, 0);
  assert.equal(live.owner, local);
  assert.equal(live.ownerConflict, false);
  assert.equal(live.tracker.startedAt, 10);
  assert.deepEqual(live.tracker.events, []);
  assert.equal(live.deathRecap, null);
  assert.equal(live.clockLoss, true);
});
