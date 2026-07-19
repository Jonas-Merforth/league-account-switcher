import { createHash } from 'node:crypto';

import { PATCH_16_14_PROFILE } from './patch-16-14-profile.js';
import { inferPlayerEntityBase } from './stream-analysis.js';

export class UnsupportedKeyframeProfileError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'UnsupportedKeyframeProfileError';
    this.details = details;
  }
}

function normalizeVersion(value) {
  return String(value ?? '').trim();
}

function roundedTime(blocks) {
  const values = blocks.map((block) => Number(block.timestamp)).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function structuralRows(blocks, playerBase) {
  const playerEnd = playerBase === null ? null : playerBase + 10;
  const shapes = new Map();
  for (const block of blocks) {
    const scope = playerBase !== null
      && block.param >= playerBase
      && block.param < playerEnd
      ? 'player'
      : 'world';
    const key = `${scope}:${block.packetId}:${block.length}`;
    shapes.set(key, (shapes.get(key) ?? 0) + 1);
  }
  return [...shapes]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([shape, count]) => `${shape}:${count}`);
}

export function keyframeStructuralFingerprint(blocks) {
  const inferred = inferPlayerEntityBase(blocks);
  const playerBase = inferred?.base ?? null;
  const rows = structuralRows(blocks, playerBase);
  return {
    schema: 1,
    playerEntityCount: playerBase === null ? 0 : 10,
    playerBase,
    blockCount: blocks.length,
    packetShapeCount: rows.length,
    sha256: createHash('sha256').update(rows.join('\n')).digest('hex')
  };
}

function versionMatches(profile, clientVersion) {
  if (typeof profile.matchesVersion === 'function') {
    return profile.matchesVersion(clientVersion);
  }
  if (profile.clientVersion instanceof RegExp) {
    profile.clientVersion.lastIndex = 0;
    return profile.clientVersion.test(clientVersion);
  }
  return normalizeVersion(profile.clientVersion) === clientVersion;
}

function contextMatches(profile, context) {
  return typeof profile.matchesContext !== 'function'
    || profile.matchesContext(context);
}

function fingerprintMatches(profile, fingerprint, blocks) {
  if (typeof profile.matchesFingerprint === 'function') {
    return profile.matchesFingerprint(fingerprint, blocks);
  }
  const expected = profile.fingerprint;
  if (!expected) return false;
  return (
    Number(expected.schema ?? 1) === fingerprint.schema
    && Number(expected.playerEntityCount ?? 10) === fingerprint.playerEntityCount
    && String(expected.sha256 ?? '') === fingerprint.sha256
  );
}

function integer(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Decoder profile returned an invalid ${label}.`);
  }
  return value;
}

function nullableInteger(value, label, options) {
  return value === null || value === undefined
    ? null
    : integer(value, label, options);
}

const CAPABILITY_KEYS = Object.freeze([
  'teamScore',
  'friendScore',
  'structures',
  'objectives',
  'items'
]);

function normalizeCapabilities(value) {
  return Object.fromEntries(CAPABILITY_KEYS.map((key) => {
    const status = value?.[key] ?? 'available';
    if (status !== 'available' && status !== 'unavailable') {
      throw new Error(`Decoder profile returned invalid ${key} capability ${status}.`);
    }
    return [key, status];
  }));
}

function normalizeObjectives(value = {}) {
  return {
    dragons: integer(value.dragons ?? 0, 'dragon count'),
    barons: integer(value.barons ?? 0, 'baron count'),
    riftHeralds: integer(value.riftHeralds ?? 0, 'Rift Herald count'),
    voidGrubs: integer(value.voidGrubs ?? 0, 'Void Grub count'),
    atakhan: integer(value.atakhan ?? 0, 'Atakhan count'),
    other: integer(value.other ?? 0, 'other objective count')
  };
}

function normalizeTeam(team) {
  const teamId = integer(team?.teamId, 'team id');
  if (teamId !== 100 && teamId !== 200) {
    throw new Error(`Decoder profile returned unsupported team id ${teamId}.`);
  }
  return {
    teamId,
    kills: integer(team?.kills, 'team kill count'),
    towersDestroyed: nullableInteger(team?.towersDestroyed, 'tower count', { maximum: 11 }),
    inhibitorsDestroyed: nullableInteger(team?.inhibitorsDestroyed, 'inhibitor count'),
    objectives: normalizeObjectives(team?.objectives)
  };
}

function normalizeParticipant(participant, capabilities) {
  const participantSlot = integer(participant?.participantSlot, 'participant slot', {
    minimum: 1,
    maximum: 10
  });
  const teamId = integer(participant?.teamId, 'participant team id');
  if (teamId !== 100 && teamId !== 200) {
    throw new Error(`Decoder profile returned unsupported participant team id ${teamId}.`);
  }
  const items = Array.isArray(participant?.items)
    ? participant.items.map((item) => integer(item, 'item id')).filter(Boolean)
    : [];
  if (capabilities.items === 'unavailable' && items.length) {
    throw new Error('Decoder profile returned items while declaring them unavailable.');
  }
  return {
    participantSlot,
    teamId,
    championId: integer(participant?.championId, 'champion id', { minimum: 1 }),
    level: integer(participant?.level, 'champion level', { minimum: 1, maximum: 30 }),
    score: {
      kills: integer(participant?.score?.kills, 'player kill count'),
      deaths: integer(participant?.score?.deaths, 'player death count'),
      assists: integer(participant?.score?.assists, 'player assist count'),
      cs: integer(participant?.score?.cs, 'creep score')
    },
    items
  };
}

function validateSnapshot(snapshot, blocks) {
  const capabilities = normalizeCapabilities(snapshot?.capabilities);
  const teams = (snapshot?.teams ?? [])
    .map(normalizeTeam)
    .sort((a, b) => a.teamId - b.teamId);
  if (teams.length !== 2 || teams[0].teamId !== 100 || teams[1].teamId !== 200) {
    throw new Error('Decoder profile must return exactly teams 100 and 200.');
  }
  if (
    capabilities.structures === 'available'
    && teams.some((team) => (
      team.towersDestroyed === null || team.inhibitorsDestroyed === null
    ))
  ) {
    throw new Error('Decoder profile declared structures available without both totals.');
  }
  const participants = (snapshot?.participants ?? [])
    .map((participant) => normalizeParticipant(participant, capabilities))
    .sort((a, b) => a.participantSlot - b.participantSlot);
  if (
    participants.length !== 10
    || new Set(participants.map((participant) => participant.participantSlot)).size !== 10
  ) {
    throw new Error('Decoder profile must return exactly ten unique participant slots.');
  }
  return {
    gameTimeSeconds: Number.isFinite(snapshot?.gameTimeSeconds)
      ? Number(snapshot.gameTimeSeconds)
      : roundedTime(blocks),
    teams,
    participants,
    capabilities
  };
}

export class KeyframeSnapshotDecoder {
  constructor({ profiles } = {}) {
    this.profiles = profiles === undefined
      ? [PATCH_16_14_PROFILE]
      : [...profiles];
  }

  selectProfile({ clientVersion, fingerprint, blocks, context }) {
    const version = normalizeVersion(clientVersion);
    return this.profiles.find(
      (profile) => (
        versionMatches(profile, version)
        && contextMatches(profile, context)
        && fingerprintMatches(profile, fingerprint, blocks)
      )
    ) ?? null;
  }

  decode({ blocks, clientVersion, queueId = null, queueType = '' }) {
    const fingerprint = keyframeStructuralFingerprint(blocks);
    const context = { queueId, queueType };
    const profile = this.selectProfile({
      clientVersion,
      fingerprint,
      blocks,
      context
    });
    if (!profile) {
      throw new UnsupportedKeyframeProfileError(
        `No verified keyframe decoder profile matches observer client ${normalizeVersion(clientVersion) || 'unknown'}.`,
        {
          clientVersion: normalizeVersion(clientVersion) || null,
          fingerprint: {
            schema: fingerprint.schema,
            playerEntityCount: fingerprint.playerEntityCount,
            blockCount: fingerprint.blockCount,
            packetShapeCount: fingerprint.packetShapeCount,
            sha256: fingerprint.sha256
          }
        }
      );
    }
    if (typeof profile.decode !== 'function') {
      throw new Error(`Keyframe decoder profile ${profile.id ?? 'unknown'} has no decode function.`);
    }
    return {
      profileId: String(profile.id ?? ''),
      fingerprint,
      ...validateSnapshot(profile.decode({
        blocks,
        playerBase: fingerprint.playerBase,
        fingerprint,
        ...context
      }), blocks)
    };
  }
}

