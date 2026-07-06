import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRIENDS_CLICK_REFRESH_COOLDOWN_MS,
  shouldRefreshFriendsOnTabClick
} from '../src/renderer/friendRefreshBehavior.js';

test('friend tab click refresh requires selected sources and no active refresh', () => {
  assert.equal(shouldRefreshFriendsOnTabClick({ selectedSourceCount: 0 }), false);
  assert.equal(shouldRefreshFriendsOnTabClick({ selectedSourceCount: 2, loading: true }), false);
  assert.equal(shouldRefreshFriendsOnTabClick({ selectedSourceCount: 2, loading: false }), true);
});

test('friend tab click refresh waits after a recent auto-refresh', () => {
  const now = 100_000;

  assert.equal(
    shouldRefreshFriendsOnTabClick({
      selectedSourceCount: 1,
      lastAutoRefreshAt: now - FRIENDS_CLICK_REFRESH_COOLDOWN_MS + 1,
      now
    }),
    false
  );
  assert.equal(
    shouldRefreshFriendsOnTabClick({
      selectedSourceCount: 1,
      lastAutoRefreshAt: now - FRIENDS_CLICK_REFRESH_COOLDOWN_MS,
      now
    }),
    true
  );
});
