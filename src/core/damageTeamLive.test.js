import assert from 'node:assert/strict';
import test from 'node:test';
import { TeamLiveEstimate } from './damageTeamLive.js';
import { readHealthUpdates, unfoldReplicationVector } from './liveReplication.js';
import * as fields16_22 from './damagePacketFields16_22.js';
import * as fields16_23 from './damagePacketFields16_23.js';
import { protocol16_22, protocol16_23 } from './liveProtocol.js';
import { teamFromKeyframe, teamFromLive } from './damageTeam.js';

// Two allies (1, 2) with the local player (3) against two enemies (11, 12).
const TEAMS = new Map([[1, 100], [2, 100], [3, 100], [11, 200], [12, 200]]);

function estimator() {
  const estimate = new TeamLiveEstimate({ owner: 3 });
  estimate.setTeams(TEAMS);
  let at = 1000;
  const tick = (health, time = null) => {
    at += 100;
    estimate.replication({ time, at });
    for (const [id, value] of Object.entries(health)) estimate.health({ id: Number(id), health: value });
  };
  const hit = (time, ...owners) => { for (const owner of owners) estimate.marker({ owner, time, champion: true }); };
  const totals = (since) => { estimate.settle(); return estimate.since(since); };
  return { estimate, tick, hit, totals, now: () => at };
}

test('credits a health drop to the only opposing champion in the same hit', () => {
  const { tick, hit, totals } = estimator();
  tick({ 11: 1000, 1: 900 });
  hit(10.5, 1, 11);
  tick({ 11: 880 });
  const result = totals();
  assert.equal(result.get(1).champion, 120);
  assert.equal(result.get(1).exact, 0);
  assert.equal(result.get(11).taken, 120);
  assert.equal(result.get(11).champion, 0);
});

test('a marker after the health packet belongs to the next tick', () => {
  const { estimate, tick, hit, totals } = estimator();
  tick({ 11: 1000 });
  hit(10.5, 1, 11);
  tick({ 11: 900 });
  // Ally 2 lands a hit after that tick was sent. Its damage shows one tick later.
  hit(10.6, 2, 11);
  tick({ 11: 850 });
  const result = totals();
  assert.equal(result.get(1).champion, 100);
  assert.equal(result.get(2).champion, 50);
  assert.equal(estimate.stats.single, 2);
});

test('frames in which a champion only dealt damage do not explain its later drop', () => {
  const { tick, hit, totals } = estimator();
  tick({ 11: 1000, 1: 900 });
  // Enemy 11 hits ally 1. Nothing hits 11 in this tick.
  hit(10.5, 11, 1);
  tick({ 1: 800 });
  // Later 11 loses health with no hit marker of its own, such as a health cost.
  tick({ 11: 950 });
  const result = totals();
  assert.equal(result.get(11).champion, 100);
  assert.equal(result.get(1).champion, 0);
});

test('packets of one tick share its server time and settle together', () => {
  const { estimate, hit, totals, now } = estimator();
  estimate.replication({ time: 50, at: now() });
  estimate.health({ id: 11, health: 1000 });
  estimate.health({ id: 12, health: 1000 });
  hit(10.5, 1, 11, 12);
  estimate.replication({ time: 50.1, at: now() + 100 });
  estimate.health({ id: 11, health: 900 });
  estimate.replication({ time: 50.1, at: now() + 100 });
  estimate.health({ id: 12, health: 700 });
  assert.equal(totals().get(1).champion, 400);
  assert.equal(estimate.stats.ticks, 2);
});

test('simultaneous attackers share a drop by the number of frames each was in', () => {
  const { tick, hit, totals } = estimator();
  tick({ 11: 1000 });
  hit(11, 1, 2, 11);
  tick({ 11: 800 });
  assert.equal(totals().get(1).champion, 100);
  assert.equal(totals().get(2).champion, 100);
  // Ally 1 lands in two frames of the next tick, ally 2 in one.
  hit(11.1, 1, 11);
  hit(11.133, 1, 2, 11);
  tick({ 11: 500 });
  const result = totals();
  assert.equal(result.get(1).champion, 100 + 200);
  assert.equal(result.get(2).champion, 100 + 100);
});

test('an opponent that lost health in the same frame is a target, not the attacker', () => {
  const { tick, hit, totals } = estimator();
  tick({ 11: 1000, 12: 1000, 1: 1000 });
  // One area hit from ally 1 on both enemies. Enemy 12 is in the frame as a target.
  hit(10.5, 1, 11, 12);
  tick({ 11: 900, 12: 800 });
  const result = totals();
  assert.equal(result.get(1).champion, 300);
  assert.equal(result.get(11).champion, 0);
  assert.equal(result.get(12).champion, 0);
});

test('a trade in one frame credits both sides', () => {
  const { tick, hit, totals } = estimator();
  tick({ 11: 1000, 1: 1000 });
  hit(10.5, 1, 11);
  tick({ 11: 900, 1: 940 });
  const result = totals();
  assert.equal(result.get(1).champion, 100);
  assert.equal(result.get(11).champion, 60);
});

test('a minion or turret hit explains a drop when every opponent in the frame was hit too', () => {
  const { estimate, tick, hit, totals } = estimator();
  tick({ 11: 1000, 1: 1000 });
  hit(10.5, 1, 11);
  // A turret shot lands on ally 1 in the frame of its own attack.
  estimate.marker({ owner: 1, time: 10.5, champion: false });
  tick({ 11: 900, 1: 700 });
  const result = totals();
  assert.equal(result.get(1).champion, 100);
  assert.equal(result.get(11).champion, 0);
});

test('takes the exact hits of the local player out of the estimate', () => {
  const { estimate, tick, hit, totals } = estimator();
  tick({ 11: 1000 });
  hit(10.5, 1, 3, 11);
  estimate.ownHit({ sourceId: 3, targetId: 11, amount: 80, time: 10.5 });
  tick({ 11: 800 });
  const result = totals();
  assert.deepEqual(result.get(3), { champion: 80, exact: 80, taken: 0 });
  assert.equal(result.get(1).champion, 120);
  assert.equal(result.get(11).taken, 200);
});

test('incoming hits on the local player are exact and health is not used for them', () => {
  const { estimate, tick, hit, totals } = estimator();
  tick({ 3: 1000 });
  hit(10.5, 11, 3);
  estimate.ownHit({ sourceId: 11, targetId: 3, amount: 150, time: 10.5 });
  // A shield absorbed part of it. The reported hit still counts in full.
  tick({ 3: 900 });
  const result = totals();
  assert.deepEqual(result.get(11), { champion: 150, exact: 150, taken: 0 });
});

test('a kill notification replaces the lethal estimate with the full final hit', () => {
  const { estimate, tick, hit, totals, now } = estimator();
  tick({ 11: 300 });
  hit(10.5, 1, 11);
  tick({ 11: 0 });
  estimate.finalHit({ sourceId: 1, targetId: 11, amount: 750, at: now() + 5 });
  assert.equal(totals().get(1).champion, 750);
});

test('a kill notification that arrives first is applied to the lethal tick', () => {
  const { estimate, tick, hit, totals, now } = estimator();
  tick({ 11: 300 });
  hit(10.5, 1, 2, 11);
  estimate.finalHit({ sourceId: 2, targetId: 11, amount: 500, at: now() + 60 });
  tick({ 11: 0 });
  const result = totals();
  assert.equal(result.get(2).champion, 500);
  assert.equal(result.get(1).champion, 150);
});

test('counts only game time after the confirmed totals', () => {
  const { estimate, tick, hit } = estimator();
  tick({ 11: 1000 });
  hit(10, 1, 11);
  tick({ 11: 900 });
  hit(40, 1, 11);
  tick({ 11: 600 });
  estimate.settle();
  assert.equal(estimate.since(30).get(1).champion, 300);
  assert.equal(estimate.since(30, 35).get(1), undefined);
  assert.equal(estimate.since().get(1).champion, 400);
});

test('credits nothing without teams and ignores untracked units', () => {
  const estimate = new TeamLiveEstimate({ owner: 3 });
  estimate.replication({ time: 1, at: 0 });
  estimate.health({ id: 11, health: 1000 });
  estimate.marker({ owner: 1, time: 10, champion: true });
  estimate.marker({ owner: 11, time: 10, champion: true });
  estimate.replication({ time: 1.1, at: 100 });
  estimate.health({ id: 11, health: 500 });
  estimate.settle();
  assert.equal(estimate.events.length, 0);
});

test('reads champion health from replication records', () => {
  const record = (id, bank, fields, payload) => {
    const head = Buffer.alloc(10);
    head[0] = 1 << bank;
    head.writeUInt32LE(id, 1);
    head.writeUInt32LE(fields, 5);
    head[9] = payload.length;
    return Buffer.concat([head, payload]);
  };
  const float = (value) => { const bytes = Buffer.alloc(4); bytes.writeFloatLE(value); return bytes; };
  // 2.125 starts with a zero byte. Its escaped form puts 0xfe in front of any float.
  const vector = Buffer.concat([
    record(0x40000001, 5, 1, float(812.5)),
    record(0x40000002, 5, 1, Buffer.from([0xff])),
    record(0x40000003, 5, 0x801, Buffer.concat([Buffer.from([0xfe]), float(2.125), float(930)])),
    record(0x40000004, 5, 0x800, float(930)),
    record(0x40000005, 3, 1, float(55)),
    record(0x40009999, 5, 1, float(400))
  ]);
  assert.deepEqual(readHealthUpdates(vector, (id) => id < 0x40000100), [
    { id: 0x40000001, health: 812.5 }, { id: 0x40000002, health: 0 }, { id: 0x40000003, health: 2.125 }
  ]);
  assert.throws(() => readHealthUpdates(vector.subarray(0, vector.length - 2), () => true), /Truncated/);
  assert.deepEqual([...unfoldReplicationVector(Buffer.from([1, 5, 2, 4, 3]), (value) => value * 2)], [2, 4, 6, 8, 10]);
});

test('decodes recorded combat markers and replication packets for both builds', () => {
  assert.equal(protocol16_23.marker, 503);
  assert.equal(protocol16_23.replication, 309);
  assert.deepEqual(fields16_23.decodeCombatMarker(Buffer.from('26b838e167f3', 'hex')),
    { owner: 0x4000003e, time: 270.77642822265625, champion: true });
  assert.deepEqual(fields16_23.decodeCombatMarker(Buffer.from('2a9838e167f3', 'hex')),
    { owner: 0x40000044, time: 270.77642822265625, champion: false });
  const current = fields16_23.decodeReplication(Buffer.from('a6ce19da6c1ac1e3f0c4071a413d411a2cb9ba41414156710b', 'hex'));
  assert.equal(current.time, 313.8621826171875);
  assert.deepEqual(readHealthUpdates(current.vector, () => true), [{ id: 0x40000044, health: 271.1525573730469 }]);

  assert.equal(protocol16_22.marker, 979);
  assert.equal(protocol16_22.replication, 952);
  assert.deepEqual(fields16_22.decodeCombatMarker(Buffer.from('a5706f1a8181', 'hex')),
    { owner: 0x40000035, time: 48.509124755859375, champion: true });
  assert.deepEqual(fields16_22.decodeCombatMarker(Buffer.from('f573579d4381', 'hex')),
    { owner: 0x4000003d, time: 59.103824615478516, champion: false });
  const previous = fields16_22.decodeReplication(Buffer.from('a642c26beb839fb9d70873a24f6452208a2007dca8ff202020', 'hex'));
  assert.equal(previous.time, 100.37725067138672);
  assert.deepEqual(readHealthUpdates(previous.vector, () => true), [{ id: 0x40000039, health: 188.60702514648438 }]);
});

test('rejects marker and replication layouts the client would read differently', () => {
  // A selector that takes the time from a default leaves no time bytes to read.
  assert.equal(fields16_23.decodeCombatMarker(Buffer.from('26ba38e167f3', 'hex')), null);
  assert.equal(fields16_22.decodeCombatMarker(Buffer.from('a5406f1a8181', 'hex')), null);
  assert.throws(() => fields16_23.decodeCombatMarker(Buffer.from('26b838e167f300', 'hex')), /Trailing/);
  assert.throws(() => fields16_23.decodeCombatMarker(Buffer.from('26b838e1', 'hex')), /Truncated/);
  assert.throws(() => fields16_23.decodeReplication(Buffer.from('a6ce19da6c1ac1e3f0c4071a413d411a2cb9ba414141', 'hex')), /trailer/);
  assert.throws(() => fields16_22.decodeReplication(Buffer.from('a642c26beb839fb9d70873a24f6452208a2007dca8ff20202000', 'hex')), /Trailing/);
});

const player = (riotId, champion, team, scores = { kills: 1, deaths: 2, assists: 3 }) => ({ riotId, championName: champion,
  rawChampionName: `game_character_displayname_${champion}`, team, scores });
const stats = (team, total) => ({ team, kills: 0, deaths: 0, assists: 0,
  damageDealt: { total: total * 2, physical: total * 2, magic: 0, true: 0 },
  damageToChampions: { total, physical: total, magic: 0, true: 0 },
  damageTaken: { total: 50, physical: 50, magic: 0, true: 0 } });

test('adds the live part to the spectator rows without touching the confirmed totals', () => {
  const roster = [player('me#1', 'Ahri', 'ORDER'), player('ally#1', 'Garen', 'ORDER'), player('foe#1', 'Zed', 'CHAOS')];
  const frame = { keyFrameId: 4, chunkId: 9, gameTime: 240, heroes: new Map([[0x40000001, stats(100, 1000)],
    [0x40000002, stats(100, 2000)], [0x40000003, stats(200, 3000)]]) };
  const live = new Map([[0x40000001, { champion: 300, exact: 300, taken: 0 }], [0x40000002, { champion: 450, exact: 0, taken: 0 }],
    [0x40000003, { champion: 0, exact: 0, taken: 750 }]]);
  const view = teamFromKeyframe(frame, { roster, playerId: 'me#1', gameTime: 290, live });
  assert.equal(view.liveSince, 240);
  const [allies, enemies] = view.teams;
  assert.deepEqual(allies.players.map((row) => [row.name, row.champion.total, row.live]), [
    ['Ahri', 1000, { champion: 300, estimated: 0 }], ['Garen', 2000, { champion: 450, estimated: 450 }]]);
  assert.equal(enemies.players[0].live, undefined);
  // Without an estimate the view is what it was before.
  const plain = teamFromKeyframe(frame, { roster, playerId: 'me#1', gameTime: 290 });
  assert.equal('liveSince' in plain, false);
  assert.equal(plain.teams[0].players.some((row) => 'live' in row), false);
});

test('shows the estimate alone before the first spectator totals', () => {
  const roster = [player('me#1', 'Ahri', 'ORDER'), player('ally#1', 'Garen', 'ORDER'), player('foe#1', 'Zed', 'CHAOS')];
  const heroes = new Map([[0x40000001, 'ahri'], [0x40000002, 'garen'], [0x40000003, 'zed']]);
  const teams = new Map([[0x40000001, 100], [0x40000002, 100], [0x40000003, 200]]);
  const live = new Map([[0x40000001, { champion: 120, exact: 120, taken: 0 }], [0x40000003, { champion: 90, exact: 40, taken: 120 }]]);
  const view = teamFromLive(live, { roster, playerId: 'me#1', heroes, teams, since: 12 });
  assert.equal(view.source, 'live');
  assert.equal(view.liveSince, 12);
  assert.deepEqual(view.teams.map((group) => [group.side, group.players.map((row) => [row.name, row.you, row.champion.total, row.live?.champion ?? 0])]), [
    ['ally', [['Ahri', true, 0, 120], ['Garen', false, 0, 0]]], ['enemy', [['Zed', false, 0, 90]]]]);
  assert.deepEqual(view.teams[1].players[0].live, { champion: 90, estimated: 50 });
  assert.equal(view.teams[0].players[0].kills, 1);
  // A champion on the wrong side of the roster means the IDs are not settled yet.
  assert.equal(teamFromLive(live, { roster, playerId: 'me#1', heroes, teams: new Map([...teams, [0x40000003, 100]]) }), null);
  assert.equal(teamFromLive(new Map(), { roster, playerId: 'me#1', heroes, teams }), null);
});
