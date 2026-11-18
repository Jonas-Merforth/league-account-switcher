import { scoreboardHeroStats } from '../heroStats.js';
import { protocolForObserver } from '../liveProtocol.js';
import { assembleScoreboard } from './scoreboard.js';

// A keyframe includes a spawn and an absolute stat snapshot for every hero.
// Their entity IDs give the join directly, even when the blocks are shuffled.
function decodeHeroes(protocol, blocks, base) {
  const champions = new Map();
  const stats = new Map();
  for (const block of blocks) {
    if (block.packetId !== protocol.heroSpawn && block.packetId !== protocol.heroStats) continue;
    if (block.length !== block.payload?.length) throw new Error('Incomplete hero block.');
    if (block.packetId === protocol.heroSpawn) {
      const spawn = protocol.fields.decodeDamageHeroSpawn(block.payload, { spectator: true });
      const catalog = protocol.scoreboard.champions;
      if (!spawn || !Object.hasOwn(catalog, spawn.model) || champions.has(spawn.id)) {
        throw new Error('Unknown or duplicate hero spawn.');
      }
      champions.set(spawn.id, catalog[spawn.model]);
    } else {
      const vector = protocol.fields.decodeHeroStatVector(block.payload);
      if (!vector || stats.has(block.param)) throw new Error('Invalid or duplicate hero snapshot.');
      stats.set(block.param, scoreboardHeroStats(vector));
    }
  }
  if (stats.size !== 10 || champions.size !== 10) throw new Error('Incomplete hero roster.');
  return Array.from({ length: 10 }, (_, slot) => {
    const championId = champions.get(base + slot);
    const hero = stats.get(base + slot);
    if (!championId || hero?.teamId !== (slot < 5 ? 100 : 200)) throw new Error('Hero roster and stats disagree.');
    return { hero, championId };
  });
}

export function liveScoreboardProfiles(protocol) {
  const patch = protocol.build.split('.').slice(0, 2).join('.');
  const { modes } = protocol.scoreboard;
  return modes.map(({ mayhem, queues, observerDelaySeconds }) => ({
    id: `league-${patch}-${mayhem ? 'mayhem-' : ''}scoreboard-v1`,
    matchesVersion: (version) => protocolForObserver(version) === protocol,
    matchesContext: ({ queueId, queueType }) => queues.includes(Number(queueId))
      || (mayhem && !Number(queueId) && String(queueType).trim().toUpperCase() === 'KIWI'),
    observerDelaySeconds,
    matchesFingerprint: (fingerprint) => fingerprint.playerEntityCount === 10 && Number.isInteger(fingerprint.playerBase),
    decode({ blocks, playerBase, queueId }) {
      const heroes = decodeHeroes(protocol, blocks, playerBase);
      const turretTotals = mayhem ? null : protocol.scoreboard.countTurrets(blocks, protocol.scoreboard.turret);
      return assembleScoreboard({ blocks, heroes, queueId, mayhem, turretTotals });
    }
  }));
}
