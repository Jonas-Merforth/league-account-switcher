import assert from 'node:assert/strict';
import test from 'node:test';
import { DamageHealthLoss } from './damageHealthLoss.js';
import { DamageTracker } from './damageTracker.js';

test('counts a lethal health drop only with a recent baseline and matching damage records', () => {
  const health = new DamageHealthLoss();
  health.update(1, 1000, 252);
  health.noteHit(1, 1200, 488, 'kill');
  health.noteHit(1, 1200, 488);
  health.update(1, 1250, 0);
  assert.deepEqual(health.matches.get('kill'), { amount: 252, attributed: true });

  health.update(1, 3000, 200);
  health.noteHit(1, 3150, 220, 'contested');
  health.noteHit(1, 3150, 220);
  health.noteHit(1, 3150, 20);
  health.update(1, 3200, 0);
  assert.equal(health.matches.has('contested'), false);

  health.update(1, 5000, 100);
  health.noteHit(1, 6000, 200, 'stale');
  health.noteHit(1, 6000, 200);
  health.update(1, 6050, 0);
  assert.equal(health.matches.has('stale'), false);
});

test('uses the combined health drop without guessing the split and marks unmatched hits', () => {
  const health = new DamageHealthLoss();
  health.update(1, 1000, 100);
  for (const [id, amount] of [['physical', 80], ['magic', 40]]) {
    health.noteHit(1, 1200, amount, id);
    health.noteHit(1, 1200, amount);
  }
  health.update(1, 1250, 0);

  const tracker = new DamageTracker();
  for (const [id, time, amount, damageType] of [['physical', 1.2, 80, 'physical'], ['magic', 1.2, 40, 'magic'], ['unmatched', 2, 30, 'true']]) {
    tracker.add({ id, time, amount, damageType, sourceId: 'me', targetKind: 'champion' });
  }
  const result = tracker.snapshot({ sourceId: 'me', now: 3, target: 'champion', healthLoss: health.matches }).total;
  assert.equal(result.total, 100);
  assert.equal(result.unattributed, 100);
  assert.equal(result.types.physical, 0);
  assert.equal(result.types.magic, 0);
  assert.equal(result.matchedHits, 2);
  assert.equal(result.hits, 3);
  assert.equal(result.dps, null);
});
