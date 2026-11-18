import {
  decodePatch1614HeroStats,
  decodePatch1614InventoryPayload,
  decodePatch1614RosterPayload,
  decodePatch1614TurretSnapshot,
  levelFromExperience,
  SUMMONERS_RIFT_TOP_EXPERIENCE_THRESHOLDS,
  PATCH_16_14_PACKET_IDS
} from './patch-16-14-codecs.js';

const HERO_PAYLOAD_LENGTH = 1_479;
const ROSTER_PAYLOAD_MIN_LENGTH = 900;
const ROSTER_PAYLOAD_MAX_LENGTH = 1_300;
const ROLE_QUEST_QUEUE_IDS = new Set([400, 420, 440, 700]);

function uniqueBlock(blocks, predicate, label) {
  const matches = blocks.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}; found ${matches.length}.`);
  }
  const [block] = matches;
  if (!Buffer.isBuffer(block.payload) || block.payload.length !== block.length) {
    throw new Error(`${label} does not retain its complete payload.`);
  }
  return block;
}

function playerParam(playerBase, slotIndex) {
  return (Number(playerBase) + slotIndex) >>> 0;
}

function emptyTeam(teamId) {
  return {
    teamId,
    kills: 0,
    towersDestroyed: null,
    inhibitorsDestroyed: null,
    objectives: {
      dragons: 0,
      barons: 0,
      riftHeralds: 0,
      voidGrubs: 0,
      atakhan: 0,
      other: 0
    }
  };
}

function addObjectives(target, credits) {
  target.dragons += credits.dragons + credits.elderDragons;
  target.barons += credits.barons;
  target.riftHeralds += credits.riftHeralds;
  target.voidGrubs += credits.voidGrubs;
  target.atakhan += credits.atakhan;
}

function participantLevel(hero, participantSlot, queueId) {
  const isTopLaneSlot = participantSlot === 1 || participantSlot === 6;
  return isTopLaneSlot && ROLE_QUEST_QUEUE_IDS.has(Number(queueId))
    ? levelFromExperience(
        hero.experience,
        SUMMONERS_RIFT_TOP_EXPERIENCE_THRESHOLDS
      )
    : hero.level;
}

function optionalInventories({
  blocks,
  playerBase,
  decodeInventory
}) {
  try {
    const inventories = new Map();
    for (let slotIndex = 0; slotIndex < 10; slotIndex += 1) {
      const participantSlot = slotIndex + 1;
      const inventoryBlock = uniqueBlock(
        blocks,
        (block) => (
          block.packetId === PATCH_16_14_PACKET_IDS.inventory
          && block.param === playerParam(playerBase, slotIndex)
        ),
        `packet 129 inventory snapshot for participant ${participantSlot}`
      );
      const inventory = decodeInventory(inventoryBlock.payload);
      if (
        !Array.isArray(inventory)
        || inventory.length !== 10
        || new Set(inventory.map((row) => row.slot)).size !== 10
      ) {
        throw new Error('Packet 129 did not produce ten unique inventory slots.');
      }
      inventories.set(participantSlot, inventory);
    }
    return inventories;
  } catch {
    // Inventory is not part of the account-switcher UI. Keep the verified
    // scoreboard available when only this independent patch-local codec moves.
    return null;
  }
}

export function decodePatch1614Snapshot({
  blocks,
  playerBase,
  queueId = null,
  decodeHero = decodePatch1614HeroStats,
  decodeInventory = decodePatch1614InventoryPayload,
  decodeRoster = decodePatch1614RosterPayload,
  decodeTurrets = decodePatch1614TurretSnapshot
}) {
  if (!Number.isInteger(playerBase)) {
    throw new Error('The 16.14 profile requires a verified player-entity base.');
  }
  const rosterBlock = uniqueBlock(
    blocks,
    (block) => (
      block.packetId === PATCH_16_14_PACKET_IDS.roster
      && block.length >= ROSTER_PAYLOAD_MIN_LENGTH
      && block.length <= ROSTER_PAYLOAD_MAX_LENGTH
    ),
    'packet 761 roster snapshot'
  );
  const roster = decodeRoster(rosterBlock.payload);
  if (
    !Array.isArray(roster)
    || roster.length !== 10
    || new Set(roster.map((row) => row.participantSlot)).size !== 10
  ) {
    throw new Error('Packet 761 did not produce ten unique participant slots.');
  }
  const rosterBySlot = new Map(roster.map((row) => [row.participantSlot, row]));
  const teams = new Map([
    [100, emptyTeam(100)],
    [200, emptyTeam(200)]
  ]);
  const turretTotals = decodeTurrets(blocks);
  if (turretTotals !== null) {
    teams.get(100).towersDestroyed = turretTotals[100];
    teams.get(200).towersDestroyed = turretTotals[200];
  }
  const inventories = optionalInventories({
    blocks,
    playerBase,
    decodeInventory
  });
  const participants = [];

  for (let slotIndex = 0; slotIndex < 10; slotIndex += 1) {
    const participantSlot = slotIndex + 1;
    const heroBlock = uniqueBlock(
      blocks,
      (block) => (
        block.packetId === PATCH_16_14_PACKET_IDS.heroSnapshot
        && block.param === playerParam(playerBase, slotIndex)
        && block.length === HERO_PAYLOAD_LENGTH
      ),
      `packet 747 hero snapshot for participant ${participantSlot}`
    );
    const hero = decodeHero(heroBlock.payload);
    const rosterRow = rosterBySlot.get(participantSlot);
    if (!rosterRow) {
      throw new Error(`Packet 761 is missing participant ${participantSlot}.`);
    }
    const team = teams.get(hero.teamId);
    if (!team) {
      throw new Error(`Packet 747 returned unsupported team ${hero.teamId}.`);
    }
    team.kills += hero.score.kills;
    addObjectives(team.objectives, hero.credits);
    participants.push({
      participantSlot,
      teamId: hero.teamId,
      championId: rosterRow.championId,
      level: participantLevel(hero, participantSlot, queueId),
      score: { ...hero.score },
      items: (inventories?.get(participantSlot) ?? [])
        .filter((row) => (
          row.slot >= 0
          && row.slot <= 6
          && row.itemId !== 0
          && row.itemId !== 0xffffffff
        ))
        .sort((left, right) => left.slot - right.slot)
        .map((row) => row.itemId)
    });
  }

  const timestamps = blocks
    .map((block) => Number(block.timestamp))
    .filter(Number.isFinite);
  return {
    gameTimeSeconds: timestamps.length ? Math.max(...timestamps) : null,
    teams: [...teams.values()],
    participants,
    capabilities: {
      teamScore: 'available',
      friendScore: 'available',
      structures: 'unavailable',
      objectives: 'available',
      items: inventories ? 'available' : 'unavailable'
    }
  };
}

export function matchesPatch1614Keyframe(fingerprint, blocks) {
  if (
    fingerprint?.schema !== 1
    || fingerprint?.playerEntityCount !== 10
    || !Number.isInteger(fingerprint?.playerBase)
    || !Array.isArray(blocks)
  ) {
    return false;
  }
  try {
    decodePatch1614Snapshot({
      blocks,
      playerBase: fingerprint.playerBase
    });
    return true;
  } catch {
    return false;
  }
}

export const PATCH_16_14_PROFILE = Object.freeze({
  id: 'league-16.14-scoreboard-v3',
  clientVersion: /^16\.14(?:\.|$)/,
  matchesFingerprint: matchesPatch1614Keyframe,
  decode: decodePatch1614Snapshot
});
