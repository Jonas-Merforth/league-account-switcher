import { countTurrets } from './spectator/riftTurrets.js';
import { PATCH_16_14_CHAMPION_IDS } from './spectator/patch-16-14-codecs.js';
import * as fields16_22 from './damagePacketFields16_22.js';
import profile16_23 from './protocols/16.23.839.6405.json' with { type: 'json' };
import { schemaFields } from './liveSchemaFields.js';

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

export function protocolFromProfile(profile) {
  if (profile.partial) throw new Error('Incomplete live protocol profile');
  const fields = schemaFields(profile);
  const protocol = { build: profile.build, ...profile.ids, fields, secondaryTimestamp: profile.secondaryTimestamp };
  if (profile.hotfixBuilds) protocol.hotfixBuilds = Object.freeze([...profile.hotfixBuilds]);
  if (profile.modes?.length) {
    protocol.scoreboard = {
      champions: PATCH_16_14_CHAMPION_IDS,
      turret: profile.ids.turret,
      countTurrets: (blocks, id) => countTurrets(blocks, id, fields.decodeTurret),
      modes: profile.modes
    };
  }
  return Object.freeze(protocol);
}

export const protocol16_23 = protocolFromProfile(profile16_23);

export const liveProtocols = Object.freeze([protocol16_22, protocol16_23]);

// Game logs and ROFL headers use four components. Research reports can use
// the same build with the final two components joined. A hotfix build is
// listed only after its layouts are verified identical to the main build.
export function matchesProtocolBuild({ build, hotfixBuilds = [] }, version) {
  return [build, ...hotfixBuilds].some((known) => version === known || version === known.replace(/\.(\d+)$/, '$1'));
}

export function protocolForBuild(version) {
  return liveProtocols.find((protocol) => matchesProtocolBuild(protocol, version)) ?? null;
}

// system.yaml provides only Releases/X.Y. A full observer version, when
// supplied, must match exactly. A patch hint must identify one known build.
export function protocolForObserver(version) {
  const exact = protocolForBuild(version);
  if (exact || !/^\d+\.\d+$/.test(version)) return exact;
  const matching = liveProtocols.filter(({ build }) => build.startsWith(version + '.'));
  return matching.length === 1 ? matching[0] : null;
}
