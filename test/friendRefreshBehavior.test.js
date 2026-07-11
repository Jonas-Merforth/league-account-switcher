import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRIENDS_CLICK_REFRESH_COOLDOWN_MS,
  friendsAutoRefreshDelay,
  shouldRefreshFriendsOnTabClick
} from '../src/renderer/friendRefreshBehavior.js';

test('auto-refresh delay becomes zero when a new interval is already due', () => {
  const now = 600_000;

  assert.equal(
    friendsAutoRefreshDelay({
      lastRefreshAt: now - 300_000,
      intervalMs: 60_000,
      now
    }),
    0
  );
  assert.equal(
    friendsAutoRefreshDelay({
      lastRefreshAt: now - 30_000,
      intervalMs: 60_000,
      now
    }),
    30_000
  );
});

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
