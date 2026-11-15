import test from 'node:test';
import assert from 'node:assert/strict';
import { DamageTracker } from './damageTracker.js';

const hit = (id, time, amount, extra = {}) => ({ id, time, amount, sourceId: 'me',
  targetKind: 'champion', damageType: 'physical', ...extra });

test('totals exclude minions; rolling window expires; fights split at the configured pause', () => {
  const t = new DamageTracker({ fightGap: 5 });
  t.add(hit('1', 1, 100));
  t.add(hit('2', 2, 50, { targetKind: 'neutral', damageType: 'magic', ability: 'Q' }));
  t.add(hit('3', 3, 1000, { targetKind: 'minion' }));
  t.add(hit('4', 7, 20, { damageType: 'true' }));
  t.add(hit('5', 8, 400, { sourceId: 'ally' }));
  assert.equal(t.add(hit('4', 7, 20)), false);
  const s = t.snapshot({ sourceId: 'me', now: 32 });
  assert.equal(s.total.total, 170);
  assert.deepEqual(s.total.types, { physical: 100, magic: 50, true: 20, unknown: 0 });
  assert.equal(s.last30.total, 20);
  assert.equal(s.last30.dps, 20 / 30);
  assert.equal(s.fights.length, 2);
  assert.equal(s.fights[0].dps, 150);
  assert.equal(s.fights[1].dps, null); // A single instant has no measurable duration.
  assert.equal(s.fights[1].active, false);
  assert.equal(t.snapshot({ sourceId: 'me', now: 40 }).last30.total, 0);
  assert.equal(t.snapshot({ sourceId: 'me', now: 40, target: 'champion' }).total.total, 120);
});

test('late starts remain partial; settings recompute intervals; resets isolate games', () => {
  const t = new DamageTracker();
  t.reset({ gameId: 'one', startedAt: 10 });
  t.add(hit('1', 11, 10)); t.add(hit('2', 17, 20, { damageType: 'unknown' }));
  assert.equal(t.snapshot({ sourceId: 'me', now: 18 }).fights.length, 1);
  t.setFightGap(5);
  const s = t.snapshot({ sourceId: 'me', now: 18 });
  assert.equal(s.fights.length, 2); assert.equal(s.partial, true);
  assert.equal(s.fights[1].active, true); assert.equal(s.last30.dps, 30 / 8);
  t.reset({ gameId: 'two' });
  assert.equal(t.snapshot({ sourceId: 'me', now: 0 }).total.dps, null);
  assert.equal(t.add(hit('1', 1, 5)), true);
});

test('malformed, reversed and over-limit events fail explicitly', () => {
  const t = new DamageTracker({ maxEvents: 2 });
  for (const patch of [{ amount: NaN }, { amount: -1 }, { time: Infinity }, { damageType: 'guessed' }]) {
    assert.throws(() => t.add(hit('bad', 1, 10, patch)));
  }
  t.add(hit('1', 2, 10));
  assert.throws(() => t.add(hit('2', 1, 10)), /ordered/);
  t.add(hit('2', 3, 10));
  assert.throws(() => t.add(hit('3', 4, 10)), /limit/);
  assert.throws(() => t.snapshot({ sourceId: 'me', now: 2 }), /clock/);
});

test('matches the recap window through respawn and starts a fresh champion fight', () => {
  const t = new DamageTracker({ fightGap: 8 });
  t.add(hit('before', 7, 1000, { packetTime: 97000 }));
  t.add(hit('start', 8, 50, { packetTime: 98000 }));
  t.add(hit('end', 13, 25, { packetTime: 103000 }));
  t.add(hit('delayed', 14, 30, { packetTime: 104000 }));
  t.add(hit('jungle', 15, 100, { packetTime: 105000, targetKind: 'neutral' }));
  const deathRecap = { time: 103000, duration: 5 };
  const state = { sourceId: 'me', now: 16, fightTarget: 'champion', deathRecap };
  const recap = t.snapshot({ ...state, nextFightAfter: 105000 });
  assert.equal(recap.total.total, 1205);
  assert.equal(recap.deathRecap.total, 75);
  assert.equal(recap.deathRecap.duration, 5);
  assert.equal(recap.deathRecap.dps, 15);
  t.add(hit('new fight', 17, 40, { packetTime: 107000 }));
  const next = t.snapshot({ ...state, now: 17, nextFightAfter: 105000 });
  assert.equal(next.deathRecap, null);
  assert.equal(next.fights.at(-1).total, 40);
});

test('uses server recap damage and hides captured source totals when a school disagrees', () => {
  const t = new DamageTracker();
  t.add(hit('burn', 14, 75.5, { packetTime: 14000, damageType: 'magic', ability: 'Burn' }));
  const deathRecap = { time: 15000, duration: 5, schools: { physical: 0, magic: 75.5, true: 0 },
    displayTypes: { physical: 0, magic: 76, true: 0 } };
  const state = { sourceId: 'me', now: 15, fightTarget: 'champion', deathRecap };
  const recap = t.snapshot(state).deathRecap;
  assert.equal(recap.total, 75.5);
  assert.equal(recap.displayTotal, 76);
  assert.deepEqual(recap.sources, [{ name: 'Burn', amount: 75.5 }]);

  const changed = { ...deathRecap, schools: { physical: 20, magic: 70.5, true: 0 },
    displayTypes: { physical: 20, magic: 71, true: 0 } };
  const mismatch = t.snapshot({ ...state, deathRecap: changed }).deathRecap;
  assert.equal(mismatch.total, 90.5);
  assert.equal(mismatch.dps, 18.1);
  assert.equal(mismatch.sourcesUnavailable, true);
  assert.deepEqual(mismatch.sources, []);
});

test('incoming champion hits advance the live fight clock without adding outgoing damage', () => {
  const t = new DamageTracker({ fightGap: 10 });
  const incoming = (id, time, sourceId, amount) => hit(id, time, amount, { incoming: true,
    sourceId, targetId: 1, packetTime: time * 1000 });
  const state = { sourceId: '1', target: 'champion', fightTarget: 'champion', estimateRecap: true,
    targetKinds: new Map([[2, 'champion'], [3, 'neutral']]) };
  t.add(incoming('shielded', 10, '2', 0));
  const opened = t.snapshot({ ...state, now: 12 });
  assert.equal(opened.fights[0].duration, 2);
  assert.equal(opened.fights[0].total, 0);
  t.add(hit('attack', 13, 80, { sourceId: '1', targetId: 2, packetTime: 13000 }));
  t.add(incoming('enemy', 19, '2', 25));
  t.add(incoming('neutral', 25, '3', 50));
  const live = t.snapshot({ ...state, now: 28 });
  assert.equal(live.fights[0].duration, 18);
  assert.equal(live.fights[0].total, 80);
  assert.equal(live.total.total, 80);
  assert.equal(live.last30.total, 80);
  const expired = t.snapshot({ ...state, now: 30 });
  assert.equal(expired.fights[0].active, false);
  assert.equal(expired.fights[0].duration, 19);
});

test('damage taken is split by attacker and school and counts every source like League', () => {
  const t = new DamageTracker();
  const taken = (id, time, sourceId, schools, extra = {}) => hit(id, time,
    Object.values(schools).reduce((sum, value) => sum + value, 0),
    { incoming: true, sourceId, targetId: 1, schools, ...extra });
  t.add(taken('blocked', 1, '2', { physical: 0 }));
  t.add(taken('auto', 2, '2', { physical: 100 }));
  t.add(taken('spell', 3, '3', { magic: 150, true: 20 }));
  t.add(taken('ignite', 4, '2', { true: 30 }));
  t.add(taken('turret', 5, '9', { physical: 300 }));
  t.add(taken('ally', 6, '3', { magic: 999 }, { targetId: 4 }));
  t.add(hit('mine', 7, 60, { sourceId: '1', targetId: 2 }));
  const state = { sourceId: '1', now: 10, targetKinds: new Map([[2, 'champion'], [3, 'champion']]) };

  const received = t.snapshot({ ...state, target: 'champion' }).incoming;
  assert.equal(received.total, 600);
  assert.equal(received.hits, 4); // The fully blocked hit is not counted.
  assert.equal(received.dps, 60);
  assert.deepEqual(received.types, { physical: 400, magic: 150, true: 50, unknown: 0 });
  assert.deepEqual(received.attackers.map(({ id, kind, amount, hits, types }) => [id, kind, amount, hits, types]), [
    ['9', 'unclassified', 300, 1, { physical: 300, magic: 0, true: 0, unknown: 0 }],
    ['3', 'champion', 170, 1, { physical: 0, magic: 150, true: 20, unknown: 0 }],
    ['2', 'champion', 130, 2, { physical: 100, magic: 0, true: 30, unknown: 0 }]
  ]);
  // The target filter only applies to the player's own damage.
  assert.deepEqual(t.snapshot({ ...state, target: 'all' }).incoming, received);
});

test('damage dealt is split by target and follows the target filter', () => {
  const t = new DamageTracker();
  t.add(hit('a', 1, 100, { sourceId: '1', targetId: 2 }));
  t.add(hit('b', 2, 40, { sourceId: '1', targetId: 3, schools: { magic: 30, true: 10 } }));
  t.add(hit('c', 3, 60, { sourceId: '1', targetId: 2, damageType: 'magic' }));
  t.add(hit('d', 4, 500, { sourceId: '1', targetId: 9, targetKind: 'unclassified' }));
  t.add(hit('e', 5, 999, { sourceId: '7', targetId: 2 }));
  const state = { sourceId: '1', now: 10, targetKinds: new Map([[2, 'champion'], [3, 'champion']]) };
  const champions = t.snapshot({ ...state, target: 'champion' }).dealt;
  assert.equal(champions.total, 200);
  assert.equal(champions.total, t.snapshot({ ...state, target: 'champion' }).total.total);
  assert.deepEqual(champions.targets.map(({ id, kind, amount, hits, types }) => [id, kind, amount, hits, types]), [
    ['2', 'champion', 160, 2, { physical: 100, magic: 60, true: 0, unknown: 0 }],
    ['3', 'champion', 40, 1, { physical: 0, magic: 30, true: 10, unknown: 0 }]
  ]);
  const all = t.snapshot({ ...state, target: 'all' }).dealt;
  assert.equal(all.total, 700);
  assert.deepEqual(all.targets.map(({ id, kind }) => [id, kind]), [['9', 'unclassified'], ['2', 'champion'], ['3', 'champion']]);
});

test('the live estimate caps its damage window and switches out of recap on incoming combat', () => {
  const t = new DamageTracker({ fightGap: 10 });
  const state = { sourceId: '1', estimateRecap: true, fightTarget: 'champion',
    targetKinds: new Map([[2, 'champion']]) };
  for (let time = 5; time <= 54; time += 7) {
    t.add(hit(String(time), time, 10, { sourceId: '1', targetId: 2, packetTime: time * 1000 }));
  }
  const active = t.snapshot({ ...state, now: 55 }).fights.at(-1);
  assert.equal(active.duration, 45);
  assert.equal(active.total, 70);
  const deathRecap = { time: 55000, duration: 41 };
  t.add(hit('late', 56, 10, { sourceId: '1', targetId: 2, packetTime: 56000 }));
  assert.equal(t.snapshot({ ...state, deathRecap, nextFightAfter: 57000, now: 57 }).deathRecap.duration, 41);
  t.add(hit('new incoming', 58, 50, { sourceId: '2', targetId: 1, incoming: true, packetTime: 58000 }));
  const renewed = t.snapshot({ ...state, deathRecap, nextFightAfter: 57000, now: 59 });
  assert.equal(renewed.deathRecap, null);
  assert.equal(renewed.fights.at(-1).duration, 1);
  assert.equal(renewed.fights.at(-1).total, 0);
});
