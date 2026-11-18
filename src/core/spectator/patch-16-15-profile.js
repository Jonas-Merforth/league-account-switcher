import {
  decodePatch1615HeroStats,
  decodePatch1615RosterPayload,
  decodePatch1615TurretSnapshot,
  PATCH_16_15_PACKET_IDS
} from './patch-16-15-codecs.js';
import {
  levelFromExperience,
  SUMMONERS_RIFT_TOP_EXPERIENCE_THRESHOLDS
} from './patch-16-14-codecs.js';

const HERO_PAYLOAD_LENGTH = 1_479;
const SUMMONERS_RIFT_ROSTER_PAYLOAD_MIN_LENGTH = 900;
const MAYHEM_ROSTER_PAYLOAD_MIN_LENGTH = 800;
const ROSTER_PAYLOAD_MAX_LENGTH = 1_300;
const ROLE_QUEST_QUEUE_IDS = new Set([400, 420, 440, 700]);
const SUMMONERS_RIFT_QUEUE_IDS = new Set([400, 420, 440]);
const MAYHEM_QUEUE_ID = 2_400;

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

export function decodePatch1615Snapshot({
  blocks,
  playerBase,
  queueId = null,
  queueType = '',
  decodeHero = decodePatch1615HeroStats,
  decodeRoster = decodePatch1615RosterPayload,
  decodeTurrets = decodePatch1615TurretSnapshot
}) {
  const mayhem = Number(queueId) === MAYHEM_QUEUE_ID
    || String(queueType).trim().toUpperCase() === 'KIWI';
  const rosterPayloadMinLength = mayhem
    ? MAYHEM_ROSTER_PAYLOAD_MIN_LENGTH
    : SUMMONERS_RIFT_ROSTER_PAYLOAD_MIN_LENGTH;
  if (!Number.isInteger(playerBase)) {
    throw new Error('The 16.15 profile requires a verified player-entity base.');
  }
  const rosterBlock = uniqueBlock(
    blocks,
    (block) => (
      block.packetId === PATCH_16_15_PACKET_IDS.roster
      && block.length >= rosterPayloadMinLength
      && block.length <= ROSTER_PAYLOAD_MAX_LENGTH
    ),
    'packet 315 roster snapshot'
  );
  const roster = decodeRoster(rosterBlock.payload);
  if (
    !Array.isArray(roster)
    || roster.length !== 10
    || new Set(roster.map((row) => row.participantSlot)).size !== 10
  ) {
    throw new Error('Packet 315 did not produce ten unique participant slots.');
  }
  const rosterBySlot = new Map(roster.map((row) => [row.participantSlot, row]));
  const teams = new Map([
    [100, emptyTeam(100)],
    [200, emptyTeam(200)]
  ]);
  const turretTotals = mayhem ? null : decodeTurrets(blocks);
  if (!mayhem && turretTotals === null) {
    throw new Error('Packet 298 is missing the Summoner\'s Rift turret set.');
  }
  if (!mayhem) {
    teams.get(100).towersDestroyed = turretTotals[100];
    teams.get(200).towersDestroyed = turretTotals[200];
  }
  const participants = [];

  for (let slotIndex = 0; slotIndex < 10; slotIndex += 1) {
    const participantSlot = slotIndex + 1;
    const heroBlock = uniqueBlock(
      blocks,
      (block) => (
        block.packetId === PATCH_16_15_PACKET_IDS.heroSnapshot
        && block.param === playerParam(playerBase, slotIndex)
        && block.length === HERO_PAYLOAD_LENGTH
      ),
      `packet 670 hero snapshot for participant ${participantSlot}`
    );
    const hero = decodeHero(heroBlock.payload);
    const rosterRow = rosterBySlot.get(participantSlot);
    if (!rosterRow) {
      throw new Error(`Packet 315 is missing participant ${participantSlot}.`);
    }
    const team = teams.get(hero.teamId);
    if (!team) {
      throw new Error(`Packet 670 returned unsupported team ${hero.teamId}.`);
    }
    team.kills += hero.score.kills;
    if (!mayhem) addObjectives(team.objectives, hero.credits);
    participants.push({
      participantSlot,
      teamId: hero.teamId,
      championId: rosterRow.championId,
      level: participantLevel(hero, participantSlot, queueId),
      score: { ...hero.score },
      items: []
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
      objectives: mayhem ? 'unavailable' : 'available',
      // Packet 370 changed schema in 16.15. Items remain deliberately disabled
      // until their fields have independent semantic validation.
      items: 'unavailable'
    }
  };
}

function matchesPatch1615Keyframe(fingerprint, blocks, queueId) {
  if (
    fingerprint?.schema !== 1
    || fingerprint?.playerEntityCount !== 10
    || !Number.isInteger(fingerprint?.playerBase)
    || !Array.isArray(blocks)
  ) {
    return false;
  }
  try {
    decodePatch1615Snapshot({
      blocks,
      playerBase: fingerprint.playerBase,
      queueId
    });
    return true;
  } catch {
    return false;
  }
}

export const PATCH_16_15_PROFILE = Object.freeze({
  id: 'league-16.15-scoreboard-v3',
  clientVersion: /^16\.15(?:\.|$)/,
  observerDelaySeconds: 180,
  matchesContext: ({ queueId }) => SUMMONERS_RIFT_QUEUE_IDS.has(Number(queueId)),
  matchesFingerprint: (fingerprint, blocks) => (
    matchesPatch1615Keyframe(fingerprint, blocks, 420)
  ),
  decode: decodePatch1615Snapshot
});

export const PATCH_16_15_MAYHEM_PROFILE = Object.freeze({
  id: 'league-16.15-mayhem-scoreboard-v2',
  clientVersion: /^16\.15(?:\.|$)/,
  observerDelaySeconds: 60,
  matchesContext: ({ queueId, queueType }) => (
    Number(queueId) === MAYHEM_QUEUE_ID
    || String(queueType ?? '').trim().toUpperCase() === 'KIWI'
  ),
  matchesFingerprint: (fingerprint, blocks) => (
    matchesPatch1615Keyframe(fingerprint, blocks, MAYHEM_QUEUE_ID)
  ),
  decode: decodePatch1615Snapshot
});
