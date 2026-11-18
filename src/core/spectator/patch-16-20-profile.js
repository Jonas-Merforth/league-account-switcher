import {
  decodePatch1620HeroStats,
  decodePatch1620RosterPayload,
  decodePatch1620TurretSnapshot,
  PATCH_16_20_PACKET_IDS
} from './patch-16-20-codecs.js';
import { assembleScoreboard } from './scoreboard.js';

const HERO_PAYLOAD_LENGTH = 1_263;
const SUMMONERS_RIFT_ROSTER_PAYLOAD_MIN_LENGTH = 900;
const MAYHEM_ROSTER_PAYLOAD_MIN_LENGTH = 800;
const ROSTER_PAYLOAD_MAX_LENGTH = 1_300;
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

export function decodePatch1620Snapshot({
  blocks,
  playerBase,
  queueId = null,
  queueType = '',
  decodeHero = decodePatch1620HeroStats,
  decodeRoster = decodePatch1620RosterPayload,
  decodeTurrets = decodePatch1620TurretSnapshot
}) {
  const mayhem = Number(queueId) === MAYHEM_QUEUE_ID
    || String(queueType).trim().toUpperCase() === 'KIWI';
  const rosterPayloadMinLength = mayhem
    ? MAYHEM_ROSTER_PAYLOAD_MIN_LENGTH
    : SUMMONERS_RIFT_ROSTER_PAYLOAD_MIN_LENGTH;
  if (!Number.isInteger(playerBase)) {
    throw new Error('The 16.20 profile requires a verified player-entity base.');
  }
  const rosterBlock = uniqueBlock(
    blocks,
    (block) => (
      block.packetId === PATCH_16_20_PACKET_IDS.roster
      && block.length >= rosterPayloadMinLength
      && block.length <= ROSTER_PAYLOAD_MAX_LENGTH
    ),
    'packet 522 roster snapshot'
  );
  const roster = decodeRoster(rosterBlock.payload);
  if (
    !Array.isArray(roster)
    || roster.length !== 10
    || new Set(roster.map((row) => row.participantSlot)).size !== 10
  ) {
    throw new Error('Packet 522 did not produce ten unique participant slots.');
  }
  const rosterBySlot = new Map(roster.map((row) => [row.participantSlot, row]));
  const turretTotals = mayhem ? null : decodeTurrets(blocks);
  if (!mayhem && turretTotals === null) {
    throw new Error('Packet 1200 is missing the Summoner\'s Rift turret set.');
  }
  const heroes = [];

  for (let slotIndex = 0; slotIndex < 10; slotIndex += 1) {
    const participantSlot = slotIndex + 1;
    const heroBlock = uniqueBlock(
      blocks,
      (block) => (
        block.packetId === PATCH_16_20_PACKET_IDS.heroSnapshot
        && block.param === playerParam(playerBase, slotIndex)
        && block.length === HERO_PAYLOAD_LENGTH
      ),
      `packet 444 hero snapshot for participant ${participantSlot}`
    );
    const hero = decodeHero(heroBlock.payload);
    const rosterRow = rosterBySlot.get(participantSlot);
    if (!rosterRow) throw new Error(`Packet 522 is missing participant ${participantSlot}.`);
    heroes.push({ hero, championId: rosterRow.championId });
  }
  return assembleScoreboard({ blocks, heroes, queueId, mayhem, turretTotals });
}

function matchesPatch1620Keyframe(fingerprint, blocks, queueId) {
  if (
    fingerprint?.schema !== 1
    || fingerprint?.playerEntityCount !== 10
    || !Number.isInteger(fingerprint?.playerBase)
    || !Array.isArray(blocks)
  ) return false;
  try {
    decodePatch1620Snapshot({ blocks, playerBase: fingerprint.playerBase, queueId });
    return true;
  } catch {
    return false;
  }
}

export const PATCH_16_20_PROFILE = Object.freeze({
  id: 'league-16.20-scoreboard-v1',
  clientVersion: /^16\.20(?:\.|$)/,
  observerDelaySeconds: 180,
  matchesContext: ({ queueId }) => SUMMONERS_RIFT_QUEUE_IDS.has(Number(queueId)),
  matchesFingerprint: (fingerprint, blocks) => matchesPatch1620Keyframe(fingerprint, blocks, 420),
  decode: decodePatch1620Snapshot
});

export const PATCH_16_20_MAYHEM_PROFILE = Object.freeze({
  id: 'league-16.20-mayhem-scoreboard-v1',
  clientVersion: /^16\.20(?:\.|$)/,
  observerDelaySeconds: 60,
  matchesContext: ({ queueId, queueType }) => (
    Number(queueId) === MAYHEM_QUEUE_ID
    || String(queueType ?? '').trim().toUpperCase() === 'KIWI'
  ),
  matchesFingerprint: (fingerprint, blocks) => matchesPatch1620Keyframe(
    fingerprint,
    blocks,
    MAYHEM_QUEUE_ID
  ),
  decode: decodePatch1620Snapshot
});
