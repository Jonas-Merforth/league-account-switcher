import assert from 'node:assert/strict';
import test from 'node:test';

import {
  friendSpectatorStatsView,
  spectatorFreshnessLine
} from '../src/renderer/spectatorStatsView.js';

const NOW = Date.parse('2026-07-19T10:20:18.000Z');

function friend() {
  return {
    puuid: 'friend',
    presenceSource: { affinity: 'euw1' },
    activity: {
      kind: 'inGame',
      gameId: '123',
      queueLabel: 'Solo/Duo',
      championName: 'Caitlyn',
      startedAt: '2026-07-19T10:00:00.000Z'
    }
  };
}

function spectatorState() {
  return {
    enabled: true,
    unavailableFriends: [],
    games: [{
      gameId: '123',
      platformId: 'EUW1',
      queueType: 'RANKED_SOLO_5x5',
      status: 'ready',
      scoreboard: {
        gameTimeSeconds: 1_000,
        fetchedAt: '2026-07-19T10:20:00.000Z',
        teams: [
          {
            teamId: 100,
            kills: 17,
            towersDestroyed: 3,
            objectives: { dragons: 1, barons: 0, riftHeralds: 0, voidGrubs: 3, atakhan: 0 }
          },
          {
            teamId: 200,
            kills: 37,
            towersDestroyed: 4,
            objectives: { dragons: 4, barons: 0, riftHeralds: 1, voidGrubs: 0, atakhan: 1 }
          }
        ]
      },
      friends: [{
        puuid: 'friend',
        teamId: 200,
        championId: 51,
        level: 13,
        score: { kills: 4, deaths: 6, assists: 3, cs: 212 }
      }],
      lastError: null
    }]
  };
}

test('freshness line reports fetch age and approximate live delay together', () => {
  assert.equal(spectatorFreshnessLine({
    fetchedAt: '2026-07-19T10:20:00.000Z',
    startedAt: '2026-07-19T10:00:00.000Z',
    gameTimeSeconds: 1_000,
    now: NOW
  }), 'Live ~20:18 · Fetched 18s ago · ~3m 38s behind');
});

test('freshness line clamps clock skew and handles unavailable live start time', () => {
  assert.equal(spectatorFreshnessLine({
    fetchedAt: '2026-07-19T10:20:00.000Z',
    startedAt: '2026-07-19T10:19:50.000Z',
    gameTimeSeconds: 100,
    now: NOW
  }), 'Live ~0:28 · Fetched 18s ago · ~0s behind');
  assert.equal(spectatorFreshnessLine({
    fetchedAt: '2026-07-19T10:20:00.000Z',
    gameTimeSeconds: 1_000,
    now: NOW
  }), 'Live time unavailable · Fetched 18s ago · delay unavailable');
});

test('hover view includes only the selected friend and both team snapshots', () => {
  const view = friendSpectatorStatsView(friend(), spectatorState(), NOW);
  assert.equal(view.context, 'Solo/Duo · Snapshot 16:40');
  assert.deepEqual(view.friend, {
    championName: 'Caitlyn',
    level: 13,
    kills: 4,
    deaths: 6,
    assists: 3,
    cs: 212
  });
  assert.equal(view.teams.length, 2);
  assert.equal(view.teams[0].ally, false);
  assert.equal(view.teams[1].ally, true);
  assert.equal(view.teams[1].objectives.atakhan, 1);
  assert.equal('friends' in view, false);
  assert.equal('items' in view.friend, false);
});

test('hover view explains unsupported and waiting states without fake values', () => {
  const unsupported = spectatorState();
  unsupported.games[0] = {
    ...unsupported.games[0],
    status: 'unsupported',
    scoreboard: null,
    lastError: 'No verified keyframe decoder profile matches observer client 16.15.'
  };
  const view = friendSpectatorStatsView(friend(), unsupported, NOW);
  assert.equal(view.status, 'unsupported');
  assert.match(view.statusMessage, /No verified keyframe decoder profile/);
  assert.equal(view.friend, undefined);

  const unavailable = spectatorState();
  unavailable.games = [];
  unavailable.unavailableFriends = [{ puuid: 'friend', reason: 'Not supported here.' }];
  assert.equal(
    friendSpectatorStatsView(friend(), unavailable, NOW).statusMessage,
    'Not supported here.'
  );
});
