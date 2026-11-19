// Usage: node research/verifyLivePatch.mjs PYTHON ORACLE BINARY CAPTURE_ROOT
// Native helpers emit private vectors to this process. Print aggregate counts only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesProtocolBuild, protocolForObserver, protocolFromProfile } from '../src/core/liveProtocol.js';
import { liveScoreboardProfiles } from '../src/core/spectator/live-scoreboard-profile.js';
import { parseReplayBlocks } from '../src/core/spectator/block-parser.js';
import { KeyframeSnapshotDecoder } from '../src/core/spectator/keyframe-snapshot-decoder.js';
import { levelFromExperience, SUMMONERS_RIFT_TOP_EXPERIENCE_THRESHOLDS } from '../src/core/spectator/patch-16-14-codecs.js';

const [python, mode, ...args] = process.argv.slice(2);
let candidate;
let oracleArgs = [mode, ...args];
if (mode === '--profile') {
  const [recipe, profile, binary, root] = args;
  if (!root) throw new Error('Expected PYTHON --profile RECIPE PROFILE BINARY CAPTURE_ROOT');
  const source = JSON.parse(fs.readFileSync(profile));
  const map = JSON.parse(fs.readFileSync(recipe));
  assert.equal(source.sha256, map.sha256);
  assert.equal(source.build, map.build);
  assert.deepEqual(source.hotfixBuilds ?? [], Object.keys(map.hotfixes ?? {}));
  candidate = protocolFromProfile(source);
  oracleArgs = [fileURLToPath(new URL('./verify_live_keyframes.py', import.meta.url)), recipe, binary, root];
} else if (args.length !== 2) throw new Error('Expected PYTHON ORACLE BINARY CAPTURE_ROOT');
const result = spawnSync(python, oracleArgs, { encoding: 'utf8', maxBuffer: 128 << 20, timeout: 300_000 });
if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
const frames = JSON.parse(result.stdout);
assert.ok(frames.length > 0);
const candidateBuild = (build) => matchesProtocolBuild(candidate, build);
const decoder = candidate ? new KeyframeSnapshotDecoder({
  profiles: liveScoreboardProfiles(candidate).map((p) => ({ ...p, matchesVersion: candidateBuild }))
}) : new KeyframeSnapshotDecoder();
const games = new Map();
const queues = {};
let heroVectors = 0;
let turrets = 0;
let patchHintFrames = 0;
for (const frame of frames) {
  const folder = path.dirname(frame.file);
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  const { build, queueId, queueType } = manifest;
  const protocol = candidate ?? protocolForObserver(build);
  assert.ok(protocol?.scoreboard, 'Unknown corpus build');
  if (candidate) {
    if (build === candidate.build.split('.').slice(0, 2).join('.')) patchHintFrames++;
    else assert.ok(candidateBuild(build), 'Candidate and capture builds differ');
    assert.ok(candidateBuild(frame.build), 'Candidate and native oracle builds differ');
  }
  else assert.equal(protocolForObserver(frame.build), protocol, 'Oracle and manifest must refer to the same build');
  const blocks = parseReplayBlocks(fs.readFileSync(frame.file), protocol);
  const snapshot = decoder.decode({ blocks, clientVersion: candidate?.build ?? build, queueId, queueType });
  const ids = Object.keys(frame.champions).map(Number).sort((a, b) => a - b);
  const mayhem = Number(queueId) === 2400 || queueType === 'KIWI';
  const expected = new Map([100, 200].map(id => [id, { kills: 0, towers: mayhem ? null : 0,
    objectives: { dragons: 0, barons: 0, riftHeralds: 0, voidGrubs: 0, atakhan: 0, other: 0 } }]));
  assert.equal(ids.length, 10);
  for (const [slot, id] of ids.entries()) {
    const row = snapshot.participants[slot];
    const block = blocks.find(b => b.packetId === protocol.heroStats && b.param === id);
    const vector = Buffer.from(frame.vectors[id], 'hex');
    assert.deepEqual(protocol.fields.decodeHeroStatVector(block.payload), vector);
    assert.equal(row.championId, protocol.scoreboard.champions[frame.champions[id]]);
    assert.equal(row.teamId, vector.readUInt32LE(0x20));
    assert.deepEqual(row.score, { kills: vector.readUInt32LE(0x4c), deaths: vector.readUInt32LE(0x50),
      assists: vector.readUInt32LE(0x54), cs: Math.round(vector.readFloatLE(0x3c) + vector.readFloatLE(0x40)) });
    const topLane = !mayhem && (slot === 0 || slot === 5);
    assert.equal(row.level, levelFromExperience(vector.readFloatLE(0x28), topLane ? SUMMONERS_RIFT_TOP_EXPERIENCE_THRESHOLDS : undefined));
    const team = expected.get(row.teamId);
    team.kills += row.score.kills;
    if (!mayhem) {
      team.objectives.dragons += vector.readUInt32LE(0xa8) + vector.readUInt32LE(0xac);
      for (const [field, offset] of [['barons', 0xa4], ['riftHeralds', 0xb0], ['voidGrubs', 0xb4], ['atakhan', 0xb8]]) {
        team.objectives[field] += vector.readUInt32LE(offset);
      }
    }
    heroVectors++;
  }
  if (!mayhem) {
    if (protocol.fields.decodeTurret) {
      for (const block of blocks.filter((b) => b.packetId === protocol.scoreboard.turret)) {
        const native = frame.turrets[block.param];
        const match = /^Turret_T(Order|Chaos)_L([012])_P([0-5])_\d+_0$/.exec(native.name);
        assert.ok(match);
        assert.deepEqual(protocol.fields.decodeTurret(block.payload),
          { side: match[1], lane: match[2], position: match[3], destroyed: native.destroyed });
      }
    }
    const rows = Object.values(frame.turrets).filter(t => !t.name.includes('_P0_'));
    assert.equal(rows.length, 22);
    for (const turret of rows) {
      assert.match(turret.name, /^Turret_T(Order|Chaos)_/);
      if (turret.destroyed) expected.get(turret.name.startsWith('Turret_TOrder_') ? 200 : 100).towers++;
      turrets++;
    }
  }
  for (const team of snapshot.teams) {
    const reference = expected.get(team.teamId);
    assert.equal(team.kills, reference.kills);
    assert.equal(team.towersDestroyed, reference.towers);
    assert.deepEqual(team.objectives, reference.objectives);
  }
  for (const id of manifest.trackedChampionIds ?? []) assert.ok(snapshot.participants.some(row => row.championId === id));
  const roster = snapshot.participants.map(row => row.championId);
  if (games.has(folder)) assert.deepEqual(roster, games.get(folder));
  games.set(folder, roster);
  queues[queueId] = (queues[queueId] ?? 0) + 1;
}
console.log(JSON.stringify({ nativeBuild: frames[0].build, games: games.size, frames: frames.length,
  heroVectors, riftTurrets: turrets, queues, patchHintFrames }));
