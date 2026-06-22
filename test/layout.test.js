import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultLayout, normalizeLayout, reconcileLayout } from '../src/core/layout.js';

test('defaultLayout is an empty top group with no sections', () => {
  assert.deepEqual(defaultLayout(), { top: [], sections: [] });
});

test('normalizeLayout coerces shape, trims, and fills section defaults', () => {
  const layout = normalizeLayout({
    top: ['a', '  b  ', 7, ''],
    sections: [{ id: ' s1 ', name: '  Smurfs ', accountIds: ['c', 1] }, { name: '' }]
  });
  assert.deepEqual(layout.top, ['a', 'b']);
  assert.equal(layout.sections[0].id, 's1');
  assert.equal(layout.sections[0].name, 'Smurfs');
  assert.equal(layout.sections[0].collapsed, false);
  assert.deepEqual(layout.sections[0].accountIds, ['c']);
  assert.equal(layout.sections[1].name, 'Section'); // default name
  assert.ok(layout.sections[1].id); // generated id
});

test('reconcileLayout appends new accounts to top, in order', () => {
  const layout = { top: ['a'], sections: [] };
  const result = reconcileLayout(layout, ['a', 'b', 'c']);
  assert.deepEqual(result.top, ['a', 'b', 'c']);
});

test('reconcileLayout prunes deleted ids from top and sections', () => {
  const layout = { top: ['a', 'gone'], sections: [{ id: 's1', name: 'S', collapsed: false, accountIds: ['b', 'dead'] }] };
  const result = reconcileLayout(layout, ['a', 'b']);
  assert.deepEqual(result.top, ['a']);
  assert.deepEqual(result.sections[0].accountIds, ['b']);
});

test('reconcileLayout dedups across groups (first occurrence wins)', () => {
  const layout = { top: ['a'], sections: [{ id: 's1', name: 'S', collapsed: false, accountIds: ['a', 'b'] }] };
  const result = reconcileLayout(layout, ['a', 'b']);
  assert.deepEqual(result.top, ['a']);
  assert.deepEqual(result.sections[0].accountIds, ['b']); // 'a' kept only in top
});

test('reconcileLayout preserves section name, order, and collapsed', () => {
  const layout = {
    top: [],
    sections: [
      { id: 's1', name: 'Main', collapsed: true, accountIds: ['a'] },
      { id: 's2', name: 'Alt', collapsed: false, accountIds: ['b'] }
    ]
  };
  const result = reconcileLayout(layout, ['a', 'b']);
  assert.equal(result.sections.length, 2);
  assert.equal(result.sections[0].name, 'Main');
  assert.equal(result.sections[0].collapsed, true);
  assert.equal(result.sections[1].id, 's2');
  assert.deepEqual(result.top, []); // a and b stay in their sections, nothing new
});
