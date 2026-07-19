import assert from 'node:assert/strict';
import test from 'node:test';

import { decodePatch1614Snapshot } from '../src/core/spectator/patch-16-14-profile.js';

const PLAYER_BASE = 0x400000ae;

function hero(slot) {
  const teamId = slot <= 5 ? 100 : 200;
  return {
    teamId,
    experience: 10_000 + slot,
    level: slot + 1,
    score: {
      kills: slot,
      deaths: 11 - slot,
      assists: slot * 2,
      cs: slot * 20
    },
    credits: {
      inhibitorsKilled: 0,
      inhibitorTakedowns: 0,
      turretsKilled: 0,
      turretTakedowns: 0,
      barons: slot === 2 || slot === 7 ? 1 : 0,
      dragons: slot === 3 || slot === 8 ? 1 : 0,
      elderDragons: slot === 4 ? 1 : 0,
      riftHeralds: slot === 1 || slot === 6 ? 1 : 0,
      voidGrubs: slot === 5 ? 3 : 0,
      atakhan: slot === 9 ? 1 : 0
    }
  };
}

function blocks() {
  return [
    {
      timestamp: 1_200.5,
      packetId: 761,
      param: 0,
      length: 900,
      payload: Buffer.alloc(900)
    },
    ...Array.from({ length: 10 }, (_, index) => ({
      timestamp: 1_200.5,
      packetId: 747,
      param: PLAYER_BASE + index,
      length: 1_479,
      payload: Buffer.alloc(1_479, index + 1)
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      timestamp: 1_200.5,
      packetId: 129,
      param: PLAYER_BASE + index,
      length: 100,
      payload: Buffer.alloc(100, index + 1)
    }))
  ];
}

function decodeInventory(payload) {
  const seed = payload[0];
  return Array.from({ length: 10 }, (_, slot) => ({
    slot,
    itemId: slot <= 6 ? seed * 1_000 + slot : 0
  }));
}

test('assembles player rows and absolute team totals from 16.14 snapshot packets', () => {
  const snapshot = decodePatch1614Snapshot({
    blocks: blocks(),
    playerBase: PLAYER_BASE,
    decodeHero: (payload) => hero(payload[0]),
    decodeInventory,
    decodeTurrets: () => ({ 100: 6, 200: 3 }),
    decodeRoster: () => Array.from({ length: 10 }, (_, index) => ({
      participantSlot: index + 1,
      championId: 100 + index
    }))
  });

  assert.equal(snapshot.gameTimeSeconds, 1_200.5);
  assert.equal(snapshot.participants[7].participantSlot, 8);
  assert.equal(snapshot.participants[7].teamId, 200);
  assert.equal(snapshot.participants[7].championId, 107);
  assert.equal(snapshot.participants[7].level, 9);
  assert.deepEqual(snapshot.participants[7].score, {
    kills: 8,
    deaths: 3,
    assists: 16,
    cs: 160
  });
  assert.deepEqual(snapshot.participants[7].items, [
    8_000, 8_001, 8_002, 8_003, 8_004, 8_005, 8_006
  ]);
  assert.deepEqual(snapshot.teams, [
    {
      teamId: 100,
      kills: 15,
      towersDestroyed: 6,
      inhibitorsDestroyed: null,
      objectives: {
        dragons: 2,
        barons: 1,
        riftHeralds: 1,
        voidGrubs: 3,
        atakhan: 0,
        other: 0
      }
    },
    {
      teamId: 200,
      kills: 40,
      towersDestroyed: 3,
      inhibitorsDestroyed: null,
      objectives: {
        dragons: 1,
        barons: 1,
        riftHeralds: 1,
        voidGrubs: 0,
        atakhan: 1,
        other: 0
      }
    }
  ]);
  assert.deepEqual(snapshot.capabilities, {
    teamScore: 'available',
    friendScore: 'available',
    structures: 'unavailable',
    objectives: 'available',
    items: 'available'
  });
});

test('rejects a missing participant snapshot instead of returning partial totals', () => {
  const input = blocks().filter((block) => block.param !== PLAYER_BASE + 7);
  assert.throws(
    () => decodePatch1614Snapshot({
      blocks: input,
      playerBase: PLAYER_BASE,
      decodeHero: (payload) => hero(payload[0]),
      decodeInventory,
      decodeRoster: () => Array.from({ length: 10 }, (_, index) => ({
        participantSlot: index + 1,
        championId: 100 + index
      }))
    }),
    /participant 8/
  );
});

test('keeps verified scores available when packet 129 inventory is unsupported', () => {
  const snapshot = decodePatch1614Snapshot({
    blocks: blocks().filter((block) => block.packetId !== 129),
    playerBase: PLAYER_BASE,
    decodeHero: (payload) => hero(payload[0]),
    decodeInventory: () => {
      throw new Error('inventory codec must not be reached without packet 129');
    },
    decodeTurrets: () => ({ 100: 6, 200: 3 }),
    decodeRoster: () => Array.from({ length: 10 }, (_, index) => ({
      participantSlot: index + 1,
      championId: 100 + index
    }))
  });

  assert.equal(snapshot.capabilities.teamScore, 'available');
  assert.equal(snapshot.capabilities.friendScore, 'available');
  assert.equal(snapshot.capabilities.objectives, 'available');
  assert.equal(snapshot.capabilities.items, 'unavailable');
  assert.equal(snapshot.teams[0].kills, 15);
  assert.equal(snapshot.teams[1].kills, 40);
  assert.ok(snapshot.participants.every((participant) => (
    participant.items.length === 0
  )));
});

test('drops every inventory when one participant inventory fails validation', () => {
  const snapshot = decodePatch1614Snapshot({
    blocks: blocks(),
    playerBase: PLAYER_BASE,
    decodeHero: (payload) => hero(payload[0]),
    decodeInventory: (payload) => {
      if (payload[0] === 8) throw new Error('changed inventory schema');
      return decodeInventory(payload);
    },
    decodeRoster: () => Array.from({ length: 10 }, (_, index) => ({
      participantSlot: index + 1,
      championId: 100 + index
    }))
  });

  assert.equal(snapshot.capabilities.items, 'unavailable');
  assert.ok(snapshot.participants.every((participant) => (
    participant.items.length === 0
  )));
});

test('applies the 2026 level-20 top-lane cap only to role-quest queues', () => {
  const decodeHero = (payload) => ({
    ...hero(payload[0]),
    experience: payload[0] === 1 || payload[0] === 6 ? 22_420 : 25_000,
    level: 18
  });
  const decodeRoster = () => Array.from({ length: 10 }, (_, index) => ({
    participantSlot: index + 1,
    championId: 100 + index
  }));
  const ranked = decodePatch1614Snapshot({
    blocks: blocks(),
    playerBase: PLAYER_BASE,
    queueId: 420,
    decodeHero,
    decodeInventory,
    decodeRoster
  });
  assert.equal(ranked.participants[0].level, 20);
  assert.equal(ranked.participants[1].level, 18);
  assert.equal(ranked.participants[5].level, 20);

  const swiftplay = decodePatch1614Snapshot({
    blocks: blocks(),
    playerBase: PLAYER_BASE,
    queueId: 490,
    decodeHero,
    decodeInventory,
    decodeRoster
  });
  assert.equal(swiftplay.participants[0].level, 18);
  assert.equal(swiftplay.participants[5].level, 18);
});
