import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FriendRankService,
  fetchFriendRanks
} from '../src/core/friendRankService.js';

function rankedPayload(tier = 'GOLD', division = 'II') {
  return {
    queueMap: {
      RANKED_SOLO_5x5: { queueType: 'RANKED_SOLO_5x5', tier, division, leaguePoints: 40, wins: 10, losses: 8 },
      RANKED_FLEX_SR: { queueType: 'RANKED_FLEX_SR', tier: 'SILVER', division: 'I', leaguePoints: 12, wins: 4, losses: 2 }
    }
  };
}

test('friend rank lookup limits concurrency and isolates failures', async () => {
  let active = 0;
  let maxActive = 0;
  const lcu = {
    get: async (endpoint) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (endpoint.includes('bad')) throw new Error('not available');
      return rankedPayload();
    }
  };
  const friends = [...Array.from({ length: 8 }, (_, i) => ({ puuid: `friend-${i}` })), { puuid: 'bad' }];
  const results = await fetchFriendRanks(lcu, friends, { concurrency: 3, now: () => 1000 });

  assert.equal(maxActive, 3);
  assert.equal(results.length, 8);
  assert.equal(results[0].ranks.solo.tier, 'GOLD');
  assert.equal(results[0].ranks.solo.wins, 10);
  assert.equal(results[0].ranks.solo.losses, null, 'Riot-redacted friend losses must not look like real zeroes');
  assert.equal(results[0].ranks.updatedAt, new Date(1000).toISOString());
});

test('friend rank service returns fresh cache immediately and expires it after the TTL', async () => {
  let now = 1_000;
  let requests = 0;
  const scheduled = [];
  const service = new FriendRankService({
    lcu: { get: async () => { requests += 1; return rankedPayload('PLATINUM', 'IV'); } },
    now: () => now,
    cacheTtlMs: 100,
    setTimer: (fn, ms) => { const timer = { fn, ms }; scheduled.push(timer); return timer; },
    clearTimer: () => {}
  });
  const updates = [];
  const first = [{ puuid: 'friend-a', online: true, activity: { kind: 'online' } }];
  service.startRefresh(first, (update) => updates.push(update));
  await scheduled.shift().fn();
  assert.equal(requests, 1);
  assert.equal(updates.length, 1);

  now += 50;
  const cached = [{ puuid: 'friend-a', online: true, activity: { kind: 'online' } }];
  service.startRefresh(cached, (update) => updates.push(update));
  assert.equal(cached[0].ranks.solo.tier, 'PLATINUM');
  assert.equal(scheduled.length, 0);

  now += 51;
  service.startRefresh([{ puuid: 'friend-a', online: true, activity: { kind: 'online' } }], () => {});
  assert.equal(scheduled.shift().ms, 0);
});

test('friend rank service schedules one two-second recheck after a game ends', async () => {
  const scheduled = [];
  const service = new FriendRankService({
    lcu: { get: async () => rankedPayload() },
    now: () => 5_000,
    cacheTtlMs: 99_999,
    postGameDelayMs: 2_000,
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; scheduled.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; }
  });
  service.cache.set('friend-a', { ranks: { solo: null, flex: null }, fetchedAt: 5_000 });
  service.startRefresh([{ puuid: 'friend-a', online: true, activity: { kind: 'inGame', gameId: 'game-1' } }]);
  assert.equal(scheduled.length, 0);

  service.startRefresh([{ puuid: 'friend-a', online: true, activity: { kind: 'postGame', gameId: 'game-1' } }]);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 2_000);

  service.startRefresh([{ puuid: 'friend-a', online: true, activity: { kind: 'postGame', gameId: 'game-1' } }]);
  assert.equal(scheduled.length, 2, 'a newer refresh replaces the still-pending post-game request');
  assert.equal(scheduled[0].cleared, true);
  await scheduled[1].fn();
  service.startRefresh([{ puuid: 'friend-a', online: true, activity: { kind: 'postGame', gameId: 'game-1' } }]);
  assert.equal(scheduled.length, 2, 'completed recheck must not repeat for the same game');
});

test('superseded rank generations cannot publish stale updates', async () => {
  const scheduled = [];
  const published = [];
  const service = new FriendRankService({
    lcu: { get: async () => rankedPayload() },
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; scheduled.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; }
  });
  service.startRefresh([{ puuid: 'old', online: true }], (update) => published.push(update));
  const oldTimer = scheduled[0];
  service.startRefresh([{ puuid: 'new', online: true }], (update) => published.push(update));
  assert.equal(oldTimer.cleared, true);
  await oldTimer.fn();
  assert.equal(published.length, 0);
});
