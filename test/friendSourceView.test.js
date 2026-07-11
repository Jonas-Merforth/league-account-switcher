import test from 'node:test';
import assert from 'node:assert/strict';
import {
  friendCardSourceSummary,
  friendSourceSummary,
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

test('friendCardSourceSummary compacts long source names sooner on narrow cards', () => {
  assert.deepEqual(
    friendCardSourceSummary(['Dr Bonk', 'reginalduOluk'], { compact: true }),
    { shown: ['Dr Bonk'], hidden: ['reginalduOluk'] }
  );
  assert.deepEqual(
    friendCardSourceSummary(['A', 'B'], { compact: true }),
    { shown: ['A', 'B'], hidden: [] }
  );
  assert.deepEqual(
    friendCardSourceSummary(['Dr Bonk', 'Acoustic'], { compact: true, hasAction: true }),
    { shown: ['Dr Bonk'], hidden: ['Acoustic'] }
  );
  assert.deepEqual(
    friendCardSourceSummary(['One very long account name'], { compact: true }),
    { shown: ['One very long account name'], hidden: [] }
  );
});

test('playing-with badge collapses to its count on compact friend cards', () => {
  assert.equal(playingWithBadgeLabel(1), 'With 1 friend');
  assert.equal(playingWithBadgeLabel(2), 'With 2 friends');
  assert.equal(playingWithBadgeLabel(1, { compact: true }), '+1');
  assert.equal(playingWithBadgeLabel(3, { compact: true }), '+3');
});
