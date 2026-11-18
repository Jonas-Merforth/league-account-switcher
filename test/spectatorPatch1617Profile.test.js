import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodePatch1617Snapshot,
  PATCH_16_17_MAYHEM_PROFILE,
  PATCH_16_17_PROFILE
} from '../src/core/spectator/patch-16-17-profile.js';

const PLAYER_BASE = 0x400000ae;

function hero(slot) {
  return {
    teamId: slot <= 5 ? 100 : 200,
    experience: 10_000 + slot,
    level: slot + 1,
    score: { kills: slot, deaths: 11 - slot, assists: slot * 2, cs: slot * 20 },
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
    { timestamp: 1_200.5, packetId: 326, param: 0, length: 1_050, payload: Buffer.alloc(1_050) },
    ...Array.from({ length: 10 }, (_, index) => ({
      timestamp: 1_200.5,
      packetId: 433,
      param: PLAYER_BASE + index,
      length: 1_495,
      payload: Buffer.alloc(1_495, index + 1)
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      timestamp: 1_200.5,
      packetId: 101,
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

test('assembles the 16.17 scoreboard and keeps inventory unavailable', () => {
  const snapshot = decodePatch1617Snapshot({
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

test('the 16.17 profiles are version, queue, and mode scoped', () => {
  assert.equal(PATCH_16_17_PROFILE.observerDelaySeconds, 180);
  assert.equal(PATCH_16_17_PROFILE.clientVersion.test('16.17.810.4348'), true);
  assert.equal(PATCH_16_17_PROFILE.clientVersion.test('16.16.810.4348'), false);
  assert.equal(PATCH_16_17_PROFILE.matchesContext({ queueId: 420 }), true);
  assert.equal(PATCH_16_17_PROFILE.matchesContext({ queueId: 400 }), true);
  assert.equal(PATCH_16_17_PROFILE.matchesContext({ queueId: 440 }), true);
  assert.equal(PATCH_16_17_PROFILE.matchesContext({ queueId: 2_400 }), false);
  assert.equal(PATCH_16_17_MAYHEM_PROFILE.matchesContext({ queueId: 2_400 }), true);
  assert.equal(PATCH_16_17_MAYHEM_PROFILE.matchesContext({ queueType: 'KIWI' }), true);
  assert.equal(PATCH_16_17_MAYHEM_PROFILE.matchesContext({ queueId: 420 }), false);
  assert.equal(PATCH_16_17_MAYHEM_PROFILE.observerDelaySeconds, 60);
});

test('rejects an incomplete 16.17 snapshot', () => {
  assert.throws(() => decodePatch1617Snapshot({
    blocks: blocks().filter((block) => block.param !== PLAYER_BASE + 7),
    playerBase: PLAYER_BASE,
    decodeHero: (payload) => hero(payload[0]),
    decodeRoster,
    decodeTurrets: () => ({ 100: 0, 200: 0 })
  }), /participant 8/);
  assert.throws(() => decodePatch1617Snapshot({
    blocks: blocks(),
    playerBase: PLAYER_BASE,
    decodeHero: (payload) => hero(payload[0]),
    decodeRoster,
    decodeTurrets: () => null
  }), /turret set/);
});

test('assembles Mayhem scores without Summoner\'s Rift map totals', () => {
  const snapshot = decodePatch1617Snapshot({
    blocks: blocks().filter((block) => block.packetId !== 101),
    playerBase: PLAYER_BASE,
    queueId: 2_400,
    queueType: 'KIWI',
    decodeHero: (payload) => hero(payload[0]),
    decodeRoster,
    decodeTurrets: () => { throw new Error('Mayhem must not invoke the Rift turret codec.'); }
  });
  assert.equal(snapshot.teams[0].towersDestroyed, null);
  assert.equal(snapshot.teams[1].towersDestroyed, null);
  assert.equal(snapshot.capabilities.objectives, 'unavailable');
  assert.equal(snapshot.capabilities.items, 'unavailable');
});

test('applies role-quest top-lane levels in Normal Draft and Ranked Flex', () => {
  for (const queueId of [400, 440]) {
    const snapshot = decodePatch1617Snapshot({
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
