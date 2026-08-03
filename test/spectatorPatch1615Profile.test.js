import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodePatch1615Snapshot,
  PATCH_16_15_MAYHEM_PROFILE,
  PATCH_16_15_PROFILE
} from '../src/core/spectator/patch-16-15-profile.js';

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
      packetId: 315,
      param: 0,
      length: 1_067,
      payload: Buffer.alloc(1_067)
    },
    ...Array.from({ length: 10 }, (_, index) => ({
      timestamp: 1_200.5,
      packetId: 670,
      param: PLAYER_BASE + index,
      length: 1_479,
      payload: Buffer.alloc(1_479, index + 1)
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      timestamp: 1_200.5,
      packetId: 370,
      param: PLAYER_BASE + index,
      length: 110,
      payload: Buffer.alloc(110, index + 1)
    }))
  ];
}

function decodeRoster() {
  return Array.from({ length: 10 }, (_, index) => ({
    participantSlot: index + 1,
    championId: 100 + index
  }));
}

test('assembles the 16.15 scoreboard and explicitly leaves inventory unavailable', () => {
  const snapshot = decodePatch1615Snapshot({
    blocks: blocks(),
    playerBase: PLAYER_BASE,
    decodeHero: (payload) => hero(payload[0]),
    decodeRoster,
    decodeTurrets: () => ({ 100: 6, 200: 3 })
  });

  assert.equal(snapshot.gameTimeSeconds, 1_200.5);
  assert.deepEqual(snapshot.participants[7], {
    participantSlot: 8,
    teamId: 200,
    championId: 107,
    level: 9,
    score: { kills: 8, deaths: 3, assists: 16, cs: 160 },
    items: []
  });
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

test('the 16.15 profile is version-scoped and rejects an incomplete snapshot', () => {
  assert.equal(PATCH_16_15_PROFILE.clientVersion.test('16.15.801.3452'), true);
  assert.equal(PATCH_16_15_PROFILE.clientVersion.test('16.14.801.3452'), false);
  assert.equal(PATCH_16_15_PROFILE.matchesContext({ queueId: 420 }), true);
  assert.equal(PATCH_16_15_PROFILE.matchesContext({ queueId: 400 }), true);
  assert.equal(PATCH_16_15_PROFILE.matchesContext({ queueId: 440 }), true);
  assert.equal(PATCH_16_15_PROFILE.matchesContext({ queueId: 2_400 }), false);
  assert.throws(
    () => decodePatch1615Snapshot({
      blocks: blocks().filter((block) => block.param !== PLAYER_BASE + 7),
      playerBase: PLAYER_BASE,
      decodeHero: (payload) => hero(payload[0]),
      decodeRoster,
      decodeTurrets: () => ({ 100: 0, 200: 0 })
    }),
    /participant 8/
  );
  assert.throws(
    () => decodePatch1615Snapshot({
      blocks: blocks(),
      playerBase: PLAYER_BASE,
      decodeHero: (payload) => hero(payload[0]),
      decodeRoster,
      decodeTurrets: () => null
    }),
    /turret set/
  );
});

test('assembles Mayhem scores without inventing Summoner\'s Rift map totals', () => {
  const input = blocks().filter((block) => block.packetId !== 370);
  input[0] = {
    ...input[0],
    length: 889,
    payload: Buffer.alloc(889)
  };
  const snapshot = decodePatch1615Snapshot({
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

  assert.equal(snapshot.teams[0].kills, 15);
  assert.equal(snapshot.teams[1].kills, 40);
  assert.equal(snapshot.teams[0].towersDestroyed, null);
  assert.equal(snapshot.teams[1].towersDestroyed, null);
  assert.deepEqual(snapshot.teams[0].objectives, {
    dragons: 0,
    barons: 0,
    riftHeralds: 0,
    voidGrubs: 0,
    atakhan: 0,
    other: 0
  });
  assert.deepEqual(snapshot.capabilities, {
    teamScore: 'available',
    friendScore: 'available',
    structures: 'unavailable',
    objectives: 'unavailable',
    items: 'unavailable'
  });
  assert.equal(PATCH_16_15_MAYHEM_PROFILE.matchesContext({ queueId: 2_400 }), true);
  assert.equal(PATCH_16_15_MAYHEM_PROFILE.matchesContext({ queueType: 'KIWI' }), true);
  assert.equal(PATCH_16_15_MAYHEM_PROFILE.matchesContext({ queueId: 420 }), false);
});

test('applies role-quest top-lane levels in Normal Draft and Ranked Flex', () => {
  for (const queueId of [400, 440]) {
    const snapshot = decodePatch1615Snapshot({
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
