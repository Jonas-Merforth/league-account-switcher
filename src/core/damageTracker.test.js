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
