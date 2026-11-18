import {
  levelFromExperience,
  SUMMONERS_RIFT_TOP_EXPERIENCE_THRESHOLDS
} from './patch-16-14-codecs.js';

const ROLE_QUEST_QUEUE_IDS = new Set([400, 420, 440, 700]);

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
    ? levelFromExperience(hero.experience, SUMMONERS_RIFT_TOP_EXPERIENCE_THRESHOLDS)
    : hero.level;
}

// Each profile supplies absolute hero rows in verified participant order.
export function assembleScoreboard({ blocks, heroes, queueId, mayhem, turretTotals }) {
  const teams = new Map([[100, emptyTeam(100)], [200, emptyTeam(200)]]);
  if (!mayhem) {
    teams.get(100).towersDestroyed = turretTotals[100];
    teams.get(200).towersDestroyed = turretTotals[200];
  }
  const participants = [];

  for (const [index, { hero, championId }] of heroes.entries()) {
    const participantSlot = index + 1;
    const team = teams.get(hero.teamId);
    if (!team) throw new Error(`Hero snapshot returned unsupported team ${hero.teamId}.`);
    team.kills += hero.score.kills;
    if (!mayhem) addObjectives(team.objectives, hero.credits);
    participants.push({
      participantSlot,
      teamId: hero.teamId,
      championId,
      level: participantLevel(hero, participantSlot, queueId),
      score: { ...hero.score },
      items: []
    });
  }

  const timestamps = blocks.map((block) => Number(block.timestamp)).filter(Number.isFinite);
  return {
    gameTimeSeconds: timestamps.length ? Math.max(...timestamps) : null,
    teams: [...teams.values()],
    participants,
    capabilities: {
      teamScore: 'available',
      friendScore: 'available',
      structures: 'unavailable',
      objectives: mayhem ? 'unavailable' : 'available',
      items: 'unavailable'
    }
  };
}
