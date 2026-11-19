import fs from 'node:fs';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { parseReplayBlocks } from '../src/core/spectator/block-parser.js';
import { PacketReader, readOwner } from '../src/core/livePacketReader.js';
import * as old22 from '../src/core/damagePacketFields16_22.js';
import * as old23 from '../src/core/damagePacketFields16_23.js';
import { schemaFields } from '../src/core/liveSchemaFields.js';
import { readReplay } from './teamChunks16_22.mjs';

const [profileFile, dumpFile, ...observerFiles] = process.argv.slice(2);
if (!dumpFile) throw new Error('Usage: node research/checkLiveProfile.mjs PROFILE RECORDING-DUMP [decompressed-keyframe-or-chunk.bin ...]');
const profile = JSON.parse(fs.readFileSync(profileFile));
const dump = JSON.parse(fs.readFileSync(dumpFile));
assert.equal(dump.build, profile.build);
const legacy = { '16.22.834.8910': old22, '16.23.839.6405': old23 }[profile.build];
if (!legacy) throw new Error('No independent reference decoder for this build');
const generated = schemaFields(profile);
const methods = { batch: 'decodeDamageBatch', combat: 'decodeCombatEvent', replication: 'decodeReplication',
  marker: 'decodeCombatMarker', heroStats: 'decodeHeroStatSnapshot', display: 'decodeSpectatorDamageDisplay',
  recap: 'decodeDeathRecap', heroSpawn: 'decodeDamageHeroSpawn' };
const counts = new Map();
function outcome(fn) {
  try { return { value: fn() }; } catch (error) { return { error: error.message }; }
}
function compare(role, payload, spectator, param) {
  const key = (spectator ? 'observer ' : 'client ') + role;
  const count = counts.get(key) ?? { value: 0, null: 0, rejected: 0, mismatch: 0 };
  counts.set(key, count);
  const method = methods[role];
  const reader = new PacketReader(payload);
  if (!spectator) {
    const owner = readOwner(reader);
    assert.equal(generated.damagePacketOwner(payload), owner);
    param = owner;
  }
  const fields = payload.subarray(reader.offset);
  let args = [payload];
  if (role === 'heroStats') args = [fields];
  if (role === 'display') args = [param, fields];
  if (role === 'heroSpawn') args = [payload, { spectator }];
  // The older spawn entry point always expects an owner prefix, which is
  // separate from the payload in a spectator block.
  const referenceArgs = legacy === old22 && spectator && role === 'heroSpawn'
    ? [Buffer.concat([Buffer.from([Buffer.from(profile.owner, 'hex').indexOf(0)]), payload])] : args;
  const expected = outcome(() => legacy[method](...referenceArgs));
  const actual = outcome(() => generated[method](...args));
  if (expected.error && actual.error) count.rejected++;
  else if (!isDeepStrictEqual(actual, expected)) {
    if (!count.mismatch) console.error(key, 'first difference', actual.error ?? Object.keys(actual.value ?? {}), expected.error ?? Object.keys(expected.value ?? {}));
    count.mismatch++;
  } else if (actual.value == null) count.null++;
  else count.value++;
  if (role === 'heroStats' && legacy.decodeHeroStatVector) {
    assert.deepEqual(generated.decodeHeroStatVector(fields), legacy.decodeHeroStatVector(fields));
  }
}
for (const role of Object.keys(methods)) {
  const samples = dump.payloads['in:' + profile.ids[role]];
  assert.ok(samples?.length, 'Missing client samples for ' + role);
  for (const hex of samples) compare(role, Buffer.from(hex, 'hex'), false);
}
function observer(data) {
  for (const block of parseReplayBlocks(data, profile)) {
    for (const role of ['heroSpawn', 'heroStats', 'display']) {
      if (profile.ids[role] === block.packetId) compare(role, block.payload, true, block.param);
    }
  }
}
for (const file of observerFiles) {
  if (/\.rofl$/i.test(file)) {
    const replay = readReplay(file);
    assert.equal(replay.build, profile.build);
    for (const segment of replay.segments) if ([1, 2].includes(segment.type)) observer(segment.data);
  } else observer(fs.readFileSync(file));
}
console.table(Object.fromEntries(counts));
if (observerFiles.length) {
  for (const role of ['heroSpawn', 'heroStats', 'display']) assert.ok(counts.get('observer ' + role)?.value, 'Missing observer evidence for ' + role);
}
if ([...counts.values()].some((c) => c.mismatch || !c.value)) process.exitCode = 1;
