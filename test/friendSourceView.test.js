import test from 'node:test';
import assert from 'node:assert/strict';
import {
  friendCardSourceSummary,
  friendFailureActionLabel,
  friendSourceSummary,
  sortFriendCardSources,
  sortFriendSourceAccounts,
  friendSourceOrder,
  playingWithBadgeLabel
} from '../src/renderer/friendSourceView.js';

function account(label, onlineCount, total, accountId) {
  return {
    accountId: accountId ?? label,
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

test('friendSourceOrder flattens the layout: unordered accounts first, then sections in order', () => {
  const layout = {
    top: ['a', 'b'],
    sections: [
      { accountIds: ['c', 'd'] },
      { accountIds: ['e'] }
    ]
  };
  assert.deepEqual(friendSourceOrder(layout), ['a', 'b', 'c', 'd', 'e']);
});

test('friendSourceOrder tolerates a missing/partial layout', () => {
  assert.deepEqual(friendSourceOrder(), []);
  assert.deepEqual(friendSourceOrder({ top: ['a'] }), ['a']);
  assert.deepEqual(friendSourceOrder({ sections: [{ accountIds: ['b'] }] }), ['b']);
});

test('sortFriendSourceAccounts follows the accounts-tab order regardless of online count', () => {
  const order = friendSourceOrder({
    top: ['x', 'y'],
    sections: [{ accountIds: ['z'] }]
  });
  assert.deepEqual(
    sortFriendSourceAccounts(
      [account('Z', 9, 9, 'z'), account('Y', 0, 1, 'y'), account('X', 3, 3, 'x')],
      order
    ).map((source) => source.label),
    ['X', 'Y', 'Z']
  );
});

test('sortFriendSourceAccounts puts accounts missing from the layout last, most-online first', () => {
  const order = friendSourceOrder({ top: ['x'], sections: [] });
  assert.deepEqual(
    sortFriendSourceAccounts(
      [account('Ghost1', 1, 1, 'g1'), account('X', 0, 1, 'x'), account('Ghost5', 5, 5, 'g5')],
      order
    ).map((source) => source.label),
    ['X', 'Ghost5', 'Ghost1']
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

test('friend failures show their classified next action', () => {
  assert.equal(friendFailureActionLabel({ recommendedAction: 'reauthenticate' }), 're-login');
  assert.equal(friendFailureActionLabel({ recommendedAction: 'inspect' }), 'inspect');
  assert.equal(friendFailureActionLabel({ recommendedAction: 'retry' }), 'retry');
  assert.equal(friendFailureActionLabel({}), 'retry');
});

test('friendCardSourceSummary always keeps one preferred source outside +N', () => {
  const summary = friendCardSourceSummary([
    { accountId: 'a', label: 'Alpha' },
    { accountId: 'b', label: 'Beta' },
    { accountId: 'c', label: 'Charlie' }
  ], { loginCounts: { a: 2, b: 8, c: 5 }, order: ['a', 'b', 'c'] });
  assert.deepEqual(summary.shown, [{ accountId: 'b', label: 'Beta' }]);
  assert.deepEqual(summary.hidden.map((source) => source.accountId), ['c', 'a']);
  assert.deepEqual(summary.all.map((source) => source.accountId), ['b', 'c', 'a']);
});

test('sortFriendCardSources breaks equal-login ties by account layout then label', () => {
  const sources = [
    { accountId: 'c', label: 'Charlie' },
    { accountId: 'a', label: 'Alpha' },
    { accountId: 'b', label: 'Beta' },
    { accountId: 'missing-z', label: 'Zulu' },
    { accountId: 'missing-d', label: 'Delta' }
  ];
  assert.deepEqual(
    sortFriendCardSources(sources, { loginCounts: { a: 3, b: 3, c: 3 }, order: ['b', 'a', 'c'] })
      .map((source) => source.accountId),
    ['b', 'a', 'c', 'missing-d', 'missing-z']
  );
});

test('playing-with badge collapses to its count on compact friend cards', () => {
  assert.equal(playingWithBadgeLabel(1), 'With 1 friend');
  assert.equal(playingWithBadgeLabel(2), 'With 2 friends');
  assert.equal(playingWithBadgeLabel(1, { compact: true }), '+1');
  assert.equal(playingWithBadgeLabel(3, { compact: true }), '+3');
});
