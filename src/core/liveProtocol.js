import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { countTurrets } from './spectator/riftTurrets.js';
import { PATCH_16_14_CHAMPION_IDS } from './spectator/patch-16-14-codecs.js';
import * as fields16_22 from './damagePacketFields16_22.js';
import { schemaFields } from './liveSchemaFields.js';
import { validateLiveProfile } from './validateLiveProfile.js';

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

const profileDir = fileURLToPath(new URL('./protocols/', import.meta.url));
const bundledSources = new Map();
const bundled = [protocol16_22];
const files = readdirSync(profileDir).filter(name => name.endsWith('.json'));
for (const file of files.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
  const source = JSON.parse(readFileSync(join(profileDir, file), 'utf8'));
  validateLiveProfile(source, file);
  checkBuilds(source, bundled);
  bundledSources.set(source.build, source);
  bundled.push(protocolFromProfile(source));
}
export const protocol16_23 = bundled.find(p => p.build === '16.23.839.6405');
export let liveProtocols = Object.freeze([...bundled]);

function checkBuilds(protocol, entries, replace = -1) {
  const versions = [protocol.build, ...(protocol.hotfixBuilds ?? [])];
  const compact = versions.map(v => v.replace(/\.(\d+)$/, '$1'));
  if (new Set(compact).size !== versions.length || compact.some(v => entries.some((p, i) =>
    i !== replace && matchesProtocolBuild(p, v)))) throw new Error('Overlapping exact builds');
}

// Called before the main process constructs either live feature. Replacing the
// list once keeps a failed file from leaving a partially installed protocol.
export function loadLocalLiveProfiles(directory, onError, managed = [], commit = true) {
  const entries = [...bundled];
  const sources = new Map(bundledSources);
  function add(source, file) {
    validateLiveProfile(source, file);
    const index = entries.findIndex(entry => entry.build === source.build);
    if (index !== -1) {
      const { hotfixBuilds = [], ...layout } = source;
      const { hotfixBuilds: known = [], ...base } = sources.get(source.build) ?? {};
      if (!isDeepStrictEqual(layout, base)) throw new Error('Conflicts with existing protocol');
      if (hotfixBuilds.every(v => known.includes(v))) return;
      source = { ...source, hotfixBuilds: [...new Set([...known, ...hotfixBuilds])] };
    }
    const protocol = protocolFromProfile(source);
    checkBuilds(protocol, entries, index);
    if (index === -1) entries.push(protocol);
    else entries[index] = protocol;
    sources.set(source.build, source);
  }
  let files;
  try { files = readdirSync(directory, { withFileTypes: true }); } catch (error) {
    if (error.code !== 'ENOENT') onError(directory, error);
    files = [];
  }
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue;
    try {
      const source = JSON.parse(readFileSync(join(directory, file.name), 'utf8'));
      add(source, file.name);
    } catch (error) { onError(file.name, error); }
  }
  for (const source of managed) add(source, source.build + '.json');
  const activate = () => { liveProtocols = Object.freeze(entries); };
  if (commit) activate();
  return activate;
}

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
