import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCardOrder } from '../src/renderer/damagePanel.js';

test('a new card joins a saved order after the card it follows by default', () => {
  const defaults = ['total', 'team', 'healing', 'fight', 'taken', 'dealt'];
  assert.deepEqual(mergeCardOrder(['total', 'fight', 'team', 'taken', 'dealt'], defaults),
    ['total', 'fight', 'team', 'healing', 'taken', 'dealt']);
  assert.deepEqual(mergeCardOrder(['dealt', 'taken', 'fight', 'team'], defaults),
    ['total', 'dealt', 'taken', 'fight', 'team', 'healing']);
  assert.deepEqual(mergeCardOrder(['team', 'gone', 'team', 'total'], defaults),
    ['team', 'healing', 'fight', 'taken', 'dealt', 'total']);
  assert.deepEqual(mergeCardOrder([], defaults), defaults);
});
