import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodePatch1616Snapshot,
  PATCH_16_16_MAYHEM_PROFILE,
  PATCH_16_16_PROFILE
} from '../src/core/spectator/patch-16-16-profile.js';

const PLAYER_BASE = 0x400000ae;

function hero(slot) {
  return {
    teamId: slot <= 5 ? 100 : 200,
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
      packetId: 827,
      param: 0,
      length: 1_050,
      payload: Buffer.alloc(1_050)
    },
    ...Array.from({ length: 10 }, (_, index) => ({
      timestamp: 1_200.5,
      packetId: 248,
      param: PLAYER_BASE + index,
      length: 1_479,
      payload: Buffer.alloc(1_479, index + 1)
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      timestamp: 1_200.5,
      packetId: 793,
      param: PLAYER_BASE + index,
      length: 120,
      payload: Buffer.alloc(120, index + 1)
    }))
  ];
}

function decodeRoster() {
  return Array.from({ length: 10 }, (_, index) => ({
    participantSlot: index + 1,
    championId: 100 + index
  }));
}

test('assembles the 16.16 scoreboard and keeps inventory unavailable', () => {
  const snapshot = decodePatch1616Snapshot({
    blocks: blocks(),
    playerBase: PLAYER_BASE,
    decodeHero: (payload) => hero(payload[0]),
    decodeRoster,
    decodeTurrets: () => ({ 100: 6, 200: 3 })
  });

  assert.equal(snapshot.gameTimeSeconds, 1_200.5);
  assert.equal(snapshot.teams[0].kills, 15);
  assert.equal(snapshot.teams[1].kills, 40);
  assert.equal(snapshot.teams[0].towersDestroyed, 6);
  assert.equal(snapshot.teams[1].towersDestroyed, 3);
  assert.deepEqual(snapshot.capabilities, {
    teamScore: 'available',
    friendScore: 'available',
    structures: 'unavailable',
    objectives: 'available',
    items: 'unavailable'
  });
  assert.ok(snapshot.participants.every((participant) => participant.items.length === 0));
});

test('the 16.16 profiles are version, queue, and mode scoped', () => {
  assert.equal(PATCH_16_16_PROFILE.observerDelaySeconds, 180);
  assert.equal(PATCH_16_16_PROFILE.clientVersion.test('16.16.804.9184'), true);
  assert.equal(PATCH_16_16_PROFILE.clientVersion.test('16.15.804.9184'), false);
  assert.equal(PATCH_16_16_PROFILE.matchesContext({ queueId: 420 }), true);
  assert.equal(PATCH_16_16_PROFILE.matchesContext({ queueId: 400 }), true);
  assert.equal(PATCH_16_16_PROFILE.matchesContext({ queueId: 440 }), true);
  assert.equal(PATCH_16_16_PROFILE.matchesContext({ queueId: 2_400 }), false);
  assert.equal(PATCH_16_16_MAYHEM_PROFILE.matchesContext({ queueId: 2_400 }), true);
  assert.equal(PATCH_16_16_MAYHEM_PROFILE.matchesContext({ queueType: 'KIWI' }), true);
  assert.equal(PATCH_16_16_MAYHEM_PROFILE.matchesContext({ queueId: 420 }), false);
  assert.equal(PATCH_16_16_MAYHEM_PROFILE.observerDelaySeconds, 60);
});

test('rejects an incomplete 16.16 snapshot', () => {
  assert.throws(
    () => decodePatch1616Snapshot({
      blocks: blocks().filter((block) => block.param !== PLAYER_BASE + 7),
      playerBase: PLAYER_BASE,
      decodeHero: (payload) => hero(payload[0]),
      decodeRoster,
      decodeTurrets: () => ({ 100: 0, 200: 0 })
    }),
    /participant 8/
  );
  assert.throws(
    () => decodePatch1616Snapshot({
      blocks: blocks(),
      playerBase: PLAYER_BASE,
      decodeHero: (payload) => hero(payload[0]),
      decodeRoster,
      decodeTurrets: () => null
    }),
    /turret set/
  );
});

test('assembles Mayhem scores without Summoner\'s Rift map totals', () => {
  const input = blocks().filter((block) => block.packetId !== 793);
  input[0] = { ...input[0], length: 850, payload: Buffer.alloc(850) };
  const snapshot = decodePatch1616Snapshot({
    blocks: input,
    playerBase: PLAYER_BASE,
    queueId: 2_400,
    queueType: 'KIWI',
    decodeHero: (payload) => hero(payload[0]),
    decodeRoster,
    decodeTurrets: () => {
      throw new Error('Mayhem must not invoke the Summoner\'s Rift turret codec.');
    }
  });

  assert.equal(snapshot.teams[0].towersDestroyed, null);
  assert.equal(snapshot.teams[1].towersDestroyed, null);
  assert.equal(snapshot.capabilities.objectives, 'unavailable');
  assert.equal(snapshot.capabilities.items, 'unavailable');
});

test('applies role-quest top-lane levels in Normal Draft and Ranked Flex', () => {
  for (const queueId of [400, 440]) {
    const snapshot = decodePatch1616Snapshot({
      blocks: blocks(),
      playerBase: PLAYER_BASE,
      queueId,
      decodeHero: (payload) => ({
        ...hero(payload[0]),
        experience: payload[0] === 1 || payload[0] === 6 ? 22_420 : 25_000,
        level: 18
      }),
      decodeRoster,
      decodeTurrets: () => ({ 100: 0, 200: 0 })
    });
    assert.equal(snapshot.participants[0].level, 20);
    assert.equal(snapshot.participants[1].level, 18);
    assert.equal(snapshot.participants[5].level, 20);
  }
});
