import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeCardOrder } from '../src/renderer/damagePanel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('renderer damagePanel only imports browser-safe modules', () => {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/^\s*import\s+[^'"]*['"]([^'"]+)['"]/gm)) {
      const target = match[1];
      assert.ok(!target.startsWith('node:'), `${path.relative(ROOT, file)} must not import ${target}`);
      assert.ok(target.startsWith('.'), `${path.relative(ROOT, file)} must not import package ${target}`);
      walk(path.resolve(path.dirname(file), target));
    }
  };
  walk(path.join(ROOT, 'src/renderer/damagePanel.js'));
});

test('a new card joins a saved order after the card it follows by default', () => {
  const defaults = ['total', 'team', 'healing', 'fight', 'taken', 'dealt', 'gold'];
  assert.deepEqual(mergeCardOrder(['total', 'fight', 'team', 'taken', 'dealt'], defaults),
    ['total', 'fight', 'team', 'healing', 'taken', 'dealt', 'gold']);
  assert.deepEqual(mergeCardOrder(['dealt', 'taken', 'fight', 'team'], defaults),
    ['total', 'dealt', 'gold', 'taken', 'fight', 'team', 'healing']);
  assert.deepEqual(mergeCardOrder(['team', 'gone', 'team', 'total'], defaults),
    ['team', 'healing', 'fight', 'taken', 'dealt', 'gold', 'total']);
  assert.deepEqual(mergeCardOrder([], defaults), defaults);
});
