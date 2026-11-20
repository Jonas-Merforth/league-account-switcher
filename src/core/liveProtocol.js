import { countRiftTurrets } from './spectator/patch-16-23-turrets.js';
import { PATCH_16_14_CHAMPION_IDS } from './spectator/patch-16-14-codecs.js';
import * as fields16_22 from './damagePacketFields16_22.js';
import * as fields16_23 from './damagePacketFields16_23.js';

export const protocol16_22 = Object.freeze({
  build: '16.22.834.8910',
  fields: fields16_22,
  combat: 743,
  batch: 1045,
  ownerAction: 618,
  heroSpawn: 43,
  recap: 1074,
  recapOwner: 419,
  heroStats: 664,
  display: 393,
  marker: 979,
  replication: 952,
  secondaryTimestamp: false
});

export const protocol16_23 = Object.freeze({
  build: '16.23.839.6405',
  // 16.23.839.9929 and 16.23.840.6595 are hotfixes with the same packet
  // layouts: same packet list and probed schemas for every role packet.
  hotfixBuilds: Object.freeze(['16.23.839.9929', '16.23.840.6595']),
  fields: fields16_23,
  combat: 172,
  batch: 314,
  ownerAction: 693,
  heroSpawn: 88,
  recap: 502,
  recapOwner: 408,
  heroStats: 313,
  display: 530,
  marker: 503,
  replication: 309,
  secondaryTimestamp: true,
  scoreboard: {
    champions: PATCH_16_14_CHAMPION_IDS,
    turret: 921,
    countTurrets: countRiftTurrets,
    modes: [
      { mayhem: false, queues: [400, 420, 440], observerDelaySeconds: 180 },
      { mayhem: true, queues: [2400], observerDelaySeconds: 60 }
    ]
  }
});

export const liveProtocols = Object.freeze([protocol16_22, protocol16_23]);

// Game logs and ROFL headers use four components. Research reports can use
// the same build with the final two components joined. A hotfix build is
// listed only after its layouts are verified identical to the main build.
export function protocolForBuild(version) {
  return liveProtocols.find(({ build, hotfixBuilds = [] }) => [build, ...hotfixBuilds]
    .some((known) => version === known || version === known.replace(/\.(\d+)$/, '$1'))) ?? null;
}

// system.yaml provides only Releases/X.Y. A full observer version, when
// supplied, must match exactly. A patch hint must identify one known build.
export function protocolForObserver(version) {
  const exact = protocolForBuild(version);
  if (exact || !/^\d+\.\d+$/.test(version)) return exact;
  const matching = liveProtocols.filter(({ build }) => build.startsWith(version + '.'));
  return matching.length === 1 ? matching[0] : null;
}
