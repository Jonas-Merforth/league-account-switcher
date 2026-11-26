import { levelFromExperience } from './spectator/patch-16-14-codecs.js';

export function readHeroKda(vector) {
  return {
    kills: vector.readUInt32LE(0x4c),
    deaths: vector.readUInt32LE(0x50),
    assists: vector.readUInt32LE(0x54)
  };
}

function finiteFloat(vector, offset, label) {
  const value = vector.readFloatLE(offset);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Hero snapshot contains an invalid ${label}.`);
  }
  return value;
}

export function scoreboardHeroStats(vector) {
  const teamId = vector.readUInt32LE(0x20);
  if (teamId !== 100 && teamId !== 200) {
    throw new Error(`Hero snapshot contains invalid team id ${teamId}.`);
  }
  const experience = finiteFloat(vector, 0x28, 'experience');
  const laneMinions = finiteFloat(vector, 0x3c, 'lane-minion count');
  const neutralMinions = finiteFloat(vector, 0x40, 'neutral-minion count');
  return {
    teamId,
    experience,
    level: levelFromExperience(experience),
    score: {
      ...readHeroKda(vector),
      cs: Math.round(laneMinions + neutralMinions)
    },
    credits: {
      inhibitorsKilled: vector.readUInt32LE(0x78),
      inhibitorTakedowns: vector.readUInt32LE(0x7c),
      turretsKilled: vector.readUInt32LE(0x80),
      turretTakedowns: vector.readUInt32LE(0x84),
      barons: vector.readUInt32LE(0xa4),
      dragons: vector.readUInt32LE(0xa8),
      elderDragons: vector.readUInt32LE(0xac),
      riftHeralds: vector.readUInt32LE(0xb0),
      voidGrubs: vector.readUInt32LE(0xb4),
      atakhan: vector.readUInt32LE(0xb8)
    }
  };
}

// Offsets follow the end-of-game stat names, which are in the same order as
// in 16.20. Checked against Match History with 16.20 spectator keyframes.
// GOLD_SPENT (0x34) and GOLD_EARNED (0x38) sit in the same float32 block as
// experience (0x28) and minion counts (0x3c, 0x40).
const GOLD_SPENT_OFFSET = 0x34;
const GOLD_EARNED_OFFSET = 0x38;
const MAX_HERO_GOLD = 500_000;
const heroDamageFields = {
  damageDealt: 0x1d0,
  damageToChampions: 0x1e0,
  damageTaken: 0x1f0
};

function goldFloat(vector, offset) {
  const value = vector.readFloatLE(offset);
  if (!Number.isFinite(value) || value < 1 || value > MAX_HERO_GOLD) return null;
  return value;
}

export function heroStatFields(vector) {
  if (!vector) return null;
  const team = vector.readUInt32LE(0x20);
  if (team !== 100 && team !== 200) return null;
  const amount = (offset) => {
    const value = vector.readFloatLE(offset);
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Invalid hero stat value');
    return value;
  };
  const goldSpent = goldFloat(vector, GOLD_SPENT_OFFSET);
  const goldEarned = goldFloat(vector, GOLD_EARNED_OFFSET);
  const stats = { team, ...readHeroKda(vector),
    ...(goldSpent !== null && { goldSpent }), ...(goldEarned !== null && { goldEarned }) };
  for (const [name, offset] of Object.entries(heroDamageFields)) {
    stats[name] = { total: amount(offset), physical: amount(offset + 4), magic: amount(offset + 8), true: amount(offset + 12) };
  }
  return stats;
}
