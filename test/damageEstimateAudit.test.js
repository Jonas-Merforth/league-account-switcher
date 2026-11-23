import test from 'node:test';
import assert from 'node:assert/strict';
import { scoringWindows } from '../research/auditDamageEstimates.mjs';

test('scores complete bursts and keeps simultaneous hits across spectator updates', () => {
  const frame = (gameTime, total, extra) => ({ gameTime,
    heroes: new Map([[1, { damageToChampions: { total } }], [2, { damageToChampions: { total: 0 } }]]), ...extra });
  const source = frame(60.01, 200);
  const hit = [70, 1, 2, 100, 'magic'];
  const next = frame(90.02, 400, { chunkId: 5, rejected: 0, hitsFrom: 60.01, championHits: [hit, hit] });
  const broken = frame(120.01, 550, { chunkId: 6, rejected: 1, hitsFrom: 90.02, championHits: [] });
  const windows = scoringWindows([source, next, next, broken, frame(120.02, 560), frame(180.02, 650)]);
  const bursts = windows.filter(w => w.hits);
  assert.deepEqual(bursts.map(w => w.to), [70, 75, 80, 85, 90]);
  assert.deepEqual(bursts.map(w => w.exact.get(1)), [200, 0, 0, 0, 0]);
  assert.deepEqual(windows.filter(w => w.frame).map(w => w.exact.get(1)), [200, 160]);
});
