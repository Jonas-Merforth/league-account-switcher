// Private corpus differential check against the official executable oracle.
// Usage: node research/verify_patch_16_20.mjs PYTHON MAC_BINARY CAPTURE_ROOT
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBlocks } from '../src/core/spectator/block-parser.js';
import { KeyframeSnapshotDecoder } from '../src/core/spectator/keyframe-snapshot-decoder.js';
import { decodePatch1620HeroSnapshotPayload, decodePatch1620RosterPayload,
  decodePatch1620TurretSnapshot } from '../src/core/spectator/patch-16-20-codecs.js';
import { levelFromExperience, SUMMONERS_RIFT_TOP_EXPERIENCE_THRESHOLDS }
  from '../src/core/spectator/patch-16-14-codecs.js';

const [python, binary, captures] = process.argv.slice(2);
if (!python || !binary || !captures) throw new Error('Expected PYTHON MAC_BINARY CAPTURE_ROOT');
const helper = fileURLToPath(new URL('./inspect_macos_16_20.py', import.meta.url));
const result = spawnSync(python, [helper, binary, captures], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000
});
if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
const frames = JSON.parse(result.stdout);
const decoder = new KeyframeSnapshotDecoder();
const games = new Map();
const queues = {};
for (const frame of frames) {
  const folder = path.dirname(frame.file);
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  const blocks = parseBlocks(fs.readFileSync(frame.file), { retainPayload: true });
  for (const hero of frame.heroes) {
    const block = blocks.find((row) => row.packetId === 444 && row.param === hero.param);
    assert.equal(decodePatch1620HeroSnapshotPayload(block.payload).toString('hex'), hero.vector);
  }
  const roster = decodePatch1620RosterPayload(blocks.find((row) => row.packetId === 522).payload);
  assert.deepEqual(roster.map((row) => row.championName), frame.roster);
  for (const championId of manifest.trackedChampionIds ?? []) {
    assert.ok(roster.some((row) => row.championId === Number(championId)),
      'A tracked presence champion is absent from the decoded roster');
  }
  if (Number(manifest.queueId) !== 2400) {
    assert.equal(frame.turrets.length, 22);
    const expected = { 100: 0, 200: 0 };
    for (const turret of frame.turrets) if (turret.destroyed) expected[turret.owner === 100 ? 200 : 100]++;
    assert.deepEqual(decodePatch1620TurretSnapshot(blocks), expected);
  }
  const snapshot = decoder.decode({ blocks, clientVersion: '16.20.824.8524',
    queueId: manifest.queueId, queueType: manifest.queueType });
  const expectedTeams = new Map([100, 200].map((teamId) => [teamId, {
    kills: 0, objectives: { dragons: 0, barons: 0, riftHeralds: 0,
      voidGrubs: 0, atakhan: 0, other: 0 }
  }]));
  for (const hero of frame.heroes) {
    const vector = Buffer.from(hero.vector, 'hex');
    const slot = hero.param - frame.playerBase;
    const participant = snapshot.participants[slot];
    assert.equal(participant.teamId, vector.readUInt32LE(0x20));
    assert.deepEqual(participant.score, {
      kills: vector.readUInt32LE(0x4c), deaths: vector.readUInt32LE(0x50),
      assists: vector.readUInt32LE(0x54),
      cs: Math.round(vector.readFloatLE(0x3c) + vector.readFloatLE(0x40))
    });
    const topLane = Number(manifest.queueId) !== 2400 && (slot === 0 || slot === 5);
    assert.equal(participant.level, levelFromExperience(vector.readFloatLE(0x28),
      topLane ? SUMMONERS_RIFT_TOP_EXPERIENCE_THRESHOLDS : undefined));
    const expected = expectedTeams.get(participant.teamId);
    expected.kills += participant.score.kills;
    if (Number(manifest.queueId) !== 2400) {
      expected.objectives.dragons += vector.readUInt32LE(0xa8) + vector.readUInt32LE(0xac);
      for (const [field, offset] of [['barons', 0xa4], ['riftHeralds', 0xb0],
        ['voidGrubs', 0xb4], ['atakhan', 0xb8]]) expected.objectives[field] += vector.readUInt32LE(offset);
    }
  }
  for (const team of snapshot.teams) {
    assert.equal(team.kills, expectedTeams.get(team.teamId).kills);
    assert.deepEqual(team.objectives, expectedTeams.get(team.teamId).objectives);
  }
  const rows = games.get(folder) ?? [];
  rows.push(snapshot);
  games.set(folder, rows);
  queues[manifest.queueId] = (queues[manifest.queueId] ?? 0) + 1;
  assert.equal(snapshot.capabilities.items, 'unavailable');
  // This exact new grammar must not pass a version hint for the previous patch.
  assert.throws(() => decoder.decode({ blocks, clientVersion: '16.19.821.7343',
    queueId: manifest.queueId, queueType: manifest.queueType }));
}
for (const snapshots of games.values()) {
  snapshots.sort((a, b) => a.gameTimeSeconds - b.gameTimeSeconds);
  const roster = snapshots[0].participants.map((row) => row.championId);
  for (let index = 0; index < snapshots.length; index++) {
    assert.deepEqual(snapshots[index].participants.map((row) => row.championId), roster);
    if (index) for (let team = 0; team < 2; team++) {
      assert.ok(snapshots[index].teams[team].kills >= snapshots[index - 1].teams[team].kills);
      assert.ok(snapshots[index].teams[team].towersDestroyed >= snapshots[index - 1].teams[team].towersDestroyed);
    }
    if (index) for (let slot = 0; slot < 10; slot++) {
      for (const field of ['kills', 'deaths', 'assists', 'cs']) {
        assert.ok(snapshots[index].participants[slot].score[field]
          >= snapshots[index - 1].participants[slot].score[field]);
      }
      assert.ok(snapshots[index].participants[slot].level
        >= snapshots[index - 1].participants[slot].level);
    }
  }
}
console.log(JSON.stringify({ frames: frames.length, games: games.size, queues,
  heroVectors: frames.length * 10, failures: 0, oracle: 'official macOS 16.20.8248524 x86-64' }));
