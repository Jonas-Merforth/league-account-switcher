import assert from 'node:assert/strict';
import test from 'node:test';

import { GameMonitor } from '../src/core/spectator/game-monitor.js';
import { KeyframeSnapshotDecoder } from '../src/core/spectator/keyframe-snapshot-decoder.js';

function framedBlock() {
  const buffer = Buffer.alloc(12);
  buffer.writeUInt8(0x10, 0);
  buffer.writeFloatLE(1200.5, 1);
  buffer.writeUInt8(1, 5);
  buffer.writeUInt16LE(1, 6);
  buffer.writeUInt32LE(0x40000000, 8);
  return Buffer.concat([buffer, Buffer.from([0])]);
}

function decodedSnapshot() {
  return {
    profileId: 'test',
    gameTimeSeconds: 1200.5,
    teams: [
      {
        teamId: 100,
        kills: 12,
        towersDestroyed: 3,
        inhibitorsDestroyed: 0,
        objectives: {
          dragons: 2, barons: 0, riftHeralds: 1, voidGrubs: 3, atakhan: 0, other: 0
        }
      },
      {
        teamId: 200,
        kills: 9,
        towersDestroyed: 1,
        inhibitorsDestroyed: 0,
        objectives: {
          dragons: 1, barons: 0, riftHeralds: 0, voidGrubs: 0, atakhan: 0, other: 0
        }
      }
    ],
    participants: Array.from({ length: 10 }, (_, index) => ({
      participantSlot: index + 1,
      teamId: index < 5 ? 100 : 200,
      championId: index + 10,
      level: 11,
      score: { kills: index, deaths: 1, assists: 2, cs: 100 + index },
      items: [1055, 3006]
    })),
    capabilities: {
      teamScore: 'available',
      friendScore: 'available',
      structures: 'available',
      objectives: 'available',
      items: 'available'
    }
  };
}

function friend(championId, suffix = '') {
  return {
    puuid: `puuid${suffix}`,
    gameName: `Friend${suffix}`,
    tagLine: 'EUW',
    queueId: 420,
    queueType: 'RANKED_SOLO_5x5',
    championId
  };
}

test('uses only the newest keyframe and skips downloading an unchanged id', async () => {
  let now = 10_000;
  let keyframeRequests = 0;
  let closeCalls = 0;
  const monitor = new GameMonitor({
    platformId: 'EUW1',
    gameId: '1',
    friends: [friend(17)],
    now: () => now,
    decoder: { decode: () => decodedSnapshot() },
    observer: {
      getMetadata: async () => ({ clientVersion: '16.14', keyFrameTimeInterval: 60_000 }),
      getLastChunkInfo: async () => ({ keyFrameId: 21 }),
      getKeyFrame: async () => {
        keyframeRequests += 1;
        return framedBlock();
      },
      getChunk: async () => assert.fail('live chunk fetching is forbidden'),
      close: async () => { closeCalls += 1; }
    }
  });

  const first = await monitor.poll({ force: true });
  assert.equal(first.status, 'ready');
  assert.equal(first.scoreboard.keyFrameId, 21);
  assert.equal(first.friends[0].participantSlot, 8);
  assert.equal(first.friends[0].teamId, 200);
  assert.equal(monitor.requestCount, 3);

  now = monitor.nextPollAt;
  const second = await monitor.poll();
  assert.equal(second.scoreboard.keyFrameId, 21);
  assert.equal(keyframeRequests, 1);
  assert.equal(monitor.requestCount, 4);
  assert.equal(closeCalls, 2);
});

test('waits with backoff while the on-demand feed has no keyframe', async () => {
  let now = 20_000;
  const monitor = new GameMonitor({
    platformId: 'EUW1',
    gameId: '1',
    now: () => now,
    observer: {
      getMetadata: async () => ({ clientVersion: '16.14' }),
      getLastChunkInfo: async () => ({ keyFrameId: 0 })
    }
  });
  const state = await monitor.poll({ force: true });
  assert.equal(state.status, 'waiting');
  assert.match(state.lastError, /not published/);
  assert.ok(monitor.nextPollAt >= now + 60_000);
  assert.ok(monitor.nextPollAt < now + 70_000);
});

test('uses the installed patch version when observer metadata omits it', async () => {
  let versionEndpointCalls = 0;
  const monitor = new GameMonitor({
    platformId: 'EUW1',
    gameId: '1',
    clientVersion: '16.14',
    decoder: { decode: ({ clientVersion }) => {
      assert.equal(clientVersion, '16.14');
      return decodedSnapshot();
    } },
    observer: {
      getMetadata: async () => ({}),
      getVersion: async () => {
        versionEndpointCalls += 1;
        return '2.36.0';
      },
      getLastChunkInfo: async () => ({ keyFrameId: 1 }),
      getKeyFrame: async () => framedBlock()
    }
  });
  const state = await monitor.poll({ force: true });
  assert.equal(state.status, 'ready');
  assert.equal(versionEndpointCalls, 0);
  assert.equal(monitor.requestCount, 3);
});

test('fails closed when no versioned profile matches', async () => {
  const monitor = new GameMonitor({
    platformId: 'EUW1',
    gameId: '1',
    decoder: new KeyframeSnapshotDecoder(),
    observer: {
      getMetadata: async () => ({ clientVersion: '16.14' }),
      getLastChunkInfo: async () => ({ keyFrameId: 1 }),
      getKeyFrame: async () => framedBlock()
    }
  });
  const state = await monitor.poll({ force: true });
  assert.equal(state.status, 'unsupported');
  assert.equal(state.scoreboard, null);
  assert.equal(state.capabilities.teamScore, 'unavailable');
  assert.match(state.lastError, /No verified keyframe decoder profile/);
});

test('does not expose an ambiguous friend mapping', async () => {
  const decoded = decodedSnapshot();
  decoded.participants[1].championId = decoded.participants[0].championId;
  const monitor = new GameMonitor({
    platformId: 'EUW1',
    gameId: '1',
    friends: [friend(decoded.participants[0].championId)],
    decoder: { decode: () => decoded },
    observer: {
      getMetadata: async () => ({ clientVersion: '16.14' }),
      getLastChunkInfo: async () => ({ keyFrameId: 1 }),
      getKeyFrame: async () => framedBlock()
    }
  });
  const state = await monitor.poll({ force: true });
  assert.equal(state.status, 'ready');
  assert.deepEqual(state.friends, []);
  assert.equal(state.capabilities.friendScore, 'unavailable');
  assert.match(state.lastError, /uniquely mapped/);
});

test('preserves profile capability gaps without hiding decoded friend scores', async () => {
  const decoded = decodedSnapshot();
  decoded.capabilities.structures = 'unavailable';
  decoded.capabilities.items = 'unavailable';
  decoded.teams = decoded.teams.map((team) => ({
    ...team,
    towersDestroyed: null,
    inhibitorsDestroyed: null
  }));
  decoded.participants = decoded.participants.map((participant) => ({
    ...participant,
    items: []
  }));
  const monitor = new GameMonitor({
    platformId: 'EUW1',
    gameId: '1',
    friends: [friend(17)],
    decoder: { decode: () => decoded },
    observer: {
      getMetadata: async () => ({ clientVersion: '16.14' }),
      getLastChunkInfo: async () => ({ keyFrameId: 1 }),
      getKeyFrame: async () => framedBlock()
    }
  });
  const state = await monitor.poll({ force: true });
  assert.equal(state.status, 'ready');
  assert.equal(state.friends[0].score.kills, 7);
  assert.deepEqual(state.friends[0].items, []);
  assert.equal(state.capabilities.friendScore, 'available');
  assert.equal(state.capabilities.teamScore, 'available');
  assert.equal(state.capabilities.objectives, 'available');
  assert.equal(state.capabilities.structures, 'unavailable');
  assert.equal(state.capabilities.items, 'unavailable');
  assert.equal(state.scoreboard.teams[0].towersDestroyed, null);
});

test('forced refresh cannot bypass a shared cooldown', async () => {
  let calls = 0;
  const monitor = new GameMonitor({
    platformId: 'EUW1',
    gameId: '1',
    now: () => 10_000,
    observer: { getMetadata: async () => { calls += 1; } }
  });
  await monitor.poll({ force: true, cooldownUntil: 70_000 });
  assert.equal(calls, 0);
});
