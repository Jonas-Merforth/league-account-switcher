// Private corpus differential check against the official executable oracle.
// Usage: node research/verify_patch_16_19.mjs PYTHON MAC_BINARY CAPTURE_ROOT
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBlocks } from '../src/core/spectator/block-parser.js';
import { KeyframeSnapshotDecoder } from '../src/core/spectator/keyframe-snapshot-decoder.js';
import { decodePatch1619HeroSnapshotPayload, decodePatch1619RosterPayload,
  decodePatch1619TurretSnapshot } from '../src/core/spectator/patch-16-19-codecs.js';

const [python, binary, captures] = process.argv.slice(2);
if (!python || !binary || !captures) throw new Error('Expected PYTHON MAC_BINARY CAPTURE_ROOT');
const helper = fileURLToPath(new URL('./inspect_macos_16_19.py', import.meta.url));
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
    const block = blocks.find((row) => row.packetId === 137 && row.param === hero.param);
    assert.equal(decodePatch1619HeroSnapshotPayload(block.payload).toString('hex'), hero.vector);
  }
  const roster = decodePatch1619RosterPayload(blocks.find((row) => row.packetId === 453).payload);
  assert.deepEqual(roster.map((row) => row.championName), frame.roster);
  for (const championId of manifest.trackedChampionIds ?? []) {
    assert.ok(roster.some((row) => row.championId === Number(championId)),
      'A tracked presence champion is absent from the decoded roster');
  }
  if (Number(manifest.queueId) !== 2400) {
    assert.equal(frame.turrets.length, 22);
    const expected = { 100: 0, 200: 0 };
    for (const turret of frame.turrets) if (turret.destroyed) expected[turret.owner === 100 ? 200 : 100]++;
    assert.deepEqual(decodePatch1619TurretSnapshot(blocks), expected);
  }
  const snapshot = decoder.decode({ blocks, clientVersion: '16.19.821.7343',
    queueId: manifest.queueId, queueType: manifest.queueType });
  const rows = games.get(folder) ?? [];
  rows.push(snapshot);
  games.set(folder, rows);
  queues[manifest.queueId] = (queues[manifest.queueId] ?? 0) + 1;
  assert.equal(snapshot.capabilities.items, 'unavailable');
  // This exact new grammar must not pass a version hint for the previous patch.
  assert.throws(() => decoder.decode({ blocks, clientVersion: '16.18.817.5716',
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
  }
}
console.log(JSON.stringify({ frames: frames.length, games: games.size, queues,
  heroVectors: frames.length * 10, failures: 0, oracle: 'official macOS 16.19.8217343 x86-64' }));
