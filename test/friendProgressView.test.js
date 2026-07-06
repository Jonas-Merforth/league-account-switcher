import test from 'node:test';
import assert from 'node:assert/strict';
import { progressHeadline, progressMeter, updateProgressRows } from '../src/renderer/friendProgressView.js';

test('progressMeter only moves by completed account count', () => {
  assert.deepEqual(
    progressMeter({ accountDone: 2, accountTotal: 5 }, 0),
    { done: 2, total: 5, percent: 40 }
  );
  assert.deepEqual(
    progressMeter({ accountDone: 9, accountTotal: 5 }, 0),
    { done: 5, total: 5, percent: 100 }
  );
});

test('progressHeadline stays stable for account-specific progress', () => {
  assert.equal(progressHeadline({ phase: 'account-presence', message: 'Fetching A - checking online status' }), 'Refreshing saved-session friend lists...');
  assert.equal(progressHeadline({ phase: 'refresh-start', message: 'Starting friend refresh' }), 'Starting friend refresh');
});

test('updateProgressRows keeps aggressive progress rows in account order', () => {
  let rows = [];
  rows = updateProgressRows(rows, { phase: 'account-start', accountIndex: 2, accountId: 'b', accountLabel: 'B', message: 'Fetching B' });
  rows = updateProgressRows(rows, { phase: 'account-start', accountIndex: 1, accountId: 'a', accountLabel: 'A', message: 'Fetching A' });
  rows = updateProgressRows(rows, { phase: 'account-done', accountIndex: 2, accountId: 'b', accountLabel: 'B', message: 'Finished B' });

  assert.deepEqual(rows.map((row) => row.label), ['A', 'B']);
  assert.deepEqual(rows.map((row) => row.status), ['active', 'done']);

  rows = updateProgressRows(rows, { phase: 'refresh-start' });
  assert.deepEqual(rows, []);
});
