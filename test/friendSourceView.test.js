import test from 'node:test';
import assert from 'node:assert/strict';
import { friendSourceSummary, sortFriendSourceAccounts } from '../src/renderer/friendSourceView.js';

function account(label, onlineCount, total) {
  return {
    label,
    onlineCount,
    friends: Array.from({ length: total }, (_, index) => ({ riotId: `${label}-${index}` }))
  };
}

test('sortFriendSourceAccounts puts sources with most online friends first', () => {
  assert.deepEqual(
    sortFriendSourceAccounts([
      account('Zero Big', 0, 100),
      account('Two', 2, 10),
      account('Five', 5, 7),
      account('Zero Small', 0, 1)
    ]).map((source) => source.label),
    ['Five', 'Two', 'Zero Big', 'Zero Small']
  );
});

test('friendSourceSummary collapses source accounts and reports hidden count', () => {
  const summary = friendSourceSummary(
    [account('A', 3, 10), account('B', 2, 10), account('C', 1, 10)],
    [{ label: 'Failed' }],
    { expanded: false, previewCount: 2 }
  );

  assert.equal(summary.hiddenCount, 2);
  assert.equal(summary.totalCount, 4);
  assert.deepEqual(summary.items.map((item) => item.account?.label || item.error?.label), ['A', 'B']);

  const expanded = friendSourceSummary(
    [account('A', 3, 10), account('B', 2, 10), account('C', 1, 10)],
    [{ label: 'Failed' }],
    { expanded: true, previewCount: 2 }
  );
  assert.equal(expanded.hiddenCount, 0);
  assert.deepEqual(
    expanded.items.map((item) => item.account?.label || item.error?.label),
    ['A', 'B', 'C', 'Failed']
  );
});
