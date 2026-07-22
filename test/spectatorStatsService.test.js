import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CADENCE_RECOVERY_MS,
  parseInstalledClientVersion,
  SpectatorStatsService,
  spectatorFriendFromPresence
} from '../src/core/spectator/spectator-stats-service.js';

test('reads the installed League patch without requiring a running client', () => {
  assert.equal(parseInstalledClientVersion('branch: "Releases/16.14"\n'), '16.14');
  assert.equal(parseInstalledClientVersion('branch: Releases/16.14.2\n'), '16.14.2');
  assert.equal(parseInstalledClientVersion('branch: Development\n'), null);
});

function mergedFriend({
  puuid = 'friend',
  gameId = 'game',
  championId = 51,
  affinity = 'euw1',
  spectatable = true,
  queueId = 420,
  queueType = 'RANKED_SOLO_5x5'
} = {}) {
  return {
    puuid,
    gameName: puuid,
    tagLine: 'EUW',
    presenceSource: { accountId: 'source', label: 'Source', affinity },
    activity: {
      kind: 'inGame',
      gameId,
      championId,
      queueId,
      gameQueueType: queueType,
      spectatable,
      startedAt: '2026-07-19T10:00:00.000Z'
    }
  };
}

function fakeMonitor({ gameId, platformId = 'EUW1', now, onPoll = () => {}, rateLimitMs = null }) {
  return {
    gameId,
    platformId,
    gameKey: `${platformId}:${gameId}`,
    friends: [],
    createdAt: now(),
    lastSeenInFriendsAt: now(),
    nextPollAt: 0,
    endedAt: null,
    requestCount: 0,
    lastErrorStatusCode: null,
    lastRetryAfterMs: null,
    updateFriends(friends) { this.friends = friends; },
    markEnded(at) { this.endedAt = at; this.nextPollAt = Infinity; },
    setRefreshInterval(ms) { this.refreshInterval = ms; },
    deferUntil(until) { this.nextPollAt = Math.max(this.nextPollAt, until); },
    shouldPoll({ cooldownUntil = 0 } = {}) {
      return this.endedAt === null && now() >= cooldownUntil && now() >= this.nextPollAt;
    },
    async poll() {
      onPoll(this.gameKey);
      this.requestCount += 2;
      if (rateLimitMs !== null && this.lastErrorStatusCode === null) {
        this.lastErrorStatusCode = 429;
        this.lastRetryAfterMs = rateLimitMs;
      } else {
        this.lastErrorStatusCode = null;
        this.lastRetryAfterMs = null;
        this.nextPollAt = now() + (this.refreshInterval ?? 60_000);
      }
    },
    snapshot() {
      return {
        gameId,
        platformId,
        queueId: 420,
        queueType: 'RANKED_SOLO_5x5',
        status: this.endedAt === null ? 'ready' : 'ended',
        scoreboard: {
          keyFrameId: 2,
          gameTimeSeconds: 600,
          estimatedLiveGameTimeSecondsAtFetch: 755,
          fetchedAt: '2026-07-19T10:10:10.000Z',
          teams: [{
            teamId: 100,
            kills: 4,
            towersDestroyed: 2,
            objectives: {
              dragons: 1, barons: 0, riftHeralds: 1, voidGrubs: 3, atakhan: 0
            }
          }]
        },
        friends: [{
          puuid: 'friend',
          participantSlot: 1,
          teamId: 100,
          championId: 51,
          level: 9,
          score: { kills: 2, deaths: 1, assists: 3, cs: 88 },
          items: [1055, 3006]
        }],
        freshness: {
          status: 'fresh', ageSeconds: 2, refreshIntervalSeconds: 60, nextRefreshAt: null
        },
        capabilities: {
          teamScore: 'available',
          friendScore: 'available',
          structures: 'available',
          objectives: 'available',
          items: 'available'
        },
        lastError: null
      };
    }
  };
}

test('maps merged friend presence to the source affinity and rejects unsupported modes', () => {
  const mapped = spectatorFriendFromPresence(mergedFriend());
  assert.equal(mapped.friend.platformId, 'EUW1');
  assert.equal(mapped.friend.gameKey, 'EUW1:game');

  assert.match(
    spectatorFriendFromPresence(mergedFriend({ queueId: 1700, queueType: 'CHERRY' })).reason,
    /not supported/
  );
  assert.match(
    spectatorFriendFromPresence(mergedFriend({ spectatable: false })).reason,
    /not mark this game as spectatable/
  );
});

test('creates one monitor for two tracked friends in one unique game', () => {
  const created = [];
  const service = new SpectatorStatsService({
    monitorFactory: (options) => {
      created.push(options);
      return fakeMonitor({ gameId: options.gameId, platformId: options.platformId, now: () => 1_000 });
    },
    now: () => 1_000
  });
  service.enabled = true;
  service.latestFriends = [
    mergedFriend({ puuid: 'one' }),
    mergedFriend({ puuid: 'two', championId: 25 })
  ];
  service.reconcileFriends();

  assert.equal(created.length, 1);
  assert.equal(created[0].friends.length, 2);
  assert.equal(service.monitors.size, 1);
});

test('serializes cycles and escalates the shared cadence after a 429', async () => {
  let now = 10_000;
  const calls = [];
  const service = new SpectatorStatsService({ now: () => now });
  service.enabled = true;
  service.monitors.set('EUW1:a', fakeMonitor({
    gameId: 'a', now: () => now, onPoll: (id) => calls.push(id), rateLimitMs: 90_000
  }));
  service.monitors.set('EUW1:b', fakeMonitor({
    gameId: 'b', now: () => now, onPoll: (id) => calls.push(id)
  }));

  await service.pollMonitors({ force: true });
  assert.deepEqual(calls, ['EUW1:a']);
  assert.equal(service.currentCadenceMs(), 120_000);
  assert.equal(service.observerCooldownUntil, 100_000);
  assert.equal(service.observer429Count, 1);
  assert.equal(service.observerRequestCount, 2);

  now = 50_000;
  await service.pollMonitors({ force: true });
  assert.deepEqual(calls, ['EUW1:a']);

  now = 100_000;
  await service.pollMonitors({ force: true });
  assert.deepEqual(calls, ['EUW1:a', 'EUW1:a']);

  now = 220_000;
  await service.pollMonitors({ force: true });
  assert.deepEqual(calls, ['EUW1:a', 'EUW1:a', 'EUW1:b']);
});

test('recovers one cadence tier per clean half hour', () => {
  let now = 1_000;
  const service = new SpectatorStatsService({ now: () => now });
  const monitor = fakeMonitor({ gameId: 'a', now: () => now });
  monitor.lastRetryAfterMs = 1_000;
  service.register429(monitor);
  now += 2_000;
  service.register429(monitor);
  assert.equal(service.currentCadenceMs(), 300_000);

  now += CADENCE_RECOVERY_MS;
  service.recoverCadenceIfEligible();
  assert.equal(service.currentCadenceMs(), 120_000);
  now += CADENCE_RECOVERY_MS;
  service.recoverCadenceIfEligible();
  assert.equal(service.currentCadenceMs(), 60_000);
});

test('marks games ended when friends leave and prunes after ten minutes', () => {
  let now = 1_000;
  const service = new SpectatorStatsService({
    monitorFactory: ({ gameId, platformId }) => fakeMonitor({ gameId, platformId, now: () => now }),
    now: () => now
  });
  service.enabled = true;
  service.latestFriends = [mergedFriend({ gameId: 'gone' })];
  service.reconcileFriends();
  const monitor = service.monitors.get('EUW1:gone');

  now = 2_000;
  service.latestFriends = [];
  service.reconcileFriends();
  assert.equal(monitor.endedAt, 2_000);
  assert.equal(monitor.shouldPoll(), false);

  now += 10 * 60_000 + 1;
  service.prune();
  assert.equal(service.monitors.size, 0);
});

test('public state removes item ids and disabling clears monitors', () => {
  const service = new SpectatorStatsService({ now: () => 1_000 });
  service.enabled = true;
  service.monitors.set(
    'EUW1:game',
    fakeMonitor({ gameId: 'game', now: () => 1_000 })
  );

  const before = service.snapshot();
  assert.equal(before.games[0].friends[0].score.cs, 88);
  assert.equal(before.games[0].scoreboard.estimatedLiveGameTimeSecondsAtFetch, 755);
  assert.equal('items' in before.games[0].friends[0], false);
  assert.equal(before.games[0].capabilities.items, undefined);
  assert.doesNotMatch(JSON.stringify(before), /1055|3006/);

  service.setEnabled(false);
  assert.equal(service.snapshot().enabled, false);
  assert.deepEqual(service.snapshot().games, []);
  assert.equal(service.monitors.size, 0);
});
