import { readFileSync } from 'node:fs';
import { readReplay } from './teamChunks16_22.mjs';
import { decodeTeamKeyframe, teamTotalsAt } from '../src/core/damageTeam.js';
import { parseReplayBlocks } from '../src/core/spectator/block-parser.js';
import { compileLayouts } from '../src/core/liveSchema.js';
import { heroStatFields } from '../src/core/heroStats.js';

// Called by build_live_profile.py --replay. Use end-of-game roster names
// and the *next* keyframe's independently stored totals to select fields.
const profile = JSON.parse(readFileSync(0));
const replay = readReplay(process.argv[2]);
if (replay.build !== profile.build) throw new Error('Replay build differs from the recipe');
const { decode } = compileLayouts(profile);
const players = JSON.parse(replay.metadata.statsJson);
if (players.length !== 10) throw new Error('Expected a ten-player replay');
const fieldsOf = (role, type) => profile.layouts[role].fields.filter(f => f.type === type).map(f => f.name);
const protocol = { ...profile.ids, secondaryTimestamp: profile.secondaryTimestamp,
  fields: { decodeHeroStatSnapshot: (data) => {
    if (data.length !== 1263) return null;
    const vector = decode.heroStats(data, true)?.values.vector;
    return vector?.length === 1260 ? heroStatFields(vector) : null;
  } } };
const frames = new Map();
const chunks = new Map();
let models = fieldsOf('heroSpawn', 'bytes');
const [idField] = fieldsOf('heroSpawn', 'id');
let spawnCount = 0;
for (const { id, type, data } of replay.segments) {
  if (type !== 1 && type !== 2) continue;
  const blocks = parseReplayBlocks(data, profile);
  if (type === 2) {
    const frame = { keyFrameId: id, ...decodeTeamKeyframe(data, protocol) };
    const ids = [...frame.heroes.keys()].sort((a, b) => a - b);
    const rows = blocks.filter(b => b.packetId === protocol.heroSpawn).map(b => decode.heroSpawn(b.payload, true).values);
    if (ids.length !== 10 || rows.length !== 10 || new Set(rows.map(r => r[idField])).size !== 10) {
      throw new Error('Incomplete hero roster in replay');
    }
    models = models.filter(name => rows.every(r => {
      const skin = players[ids.indexOf(r[idField])]?.SKIN;
      return skin && r[name].toString('latin1').toLowerCase() === skin.toLowerCase();
    }));
    spawnCount += rows.length;
    frames.set(id, frame);
  } else {
    chunks.set(id, { end: blocks.reduce((latest, b) => Math.max(latest, b.timestamp), 0),
      hits: blocks.filter(b => b.packetId === protocol.display).map(b => ({ time: b.timestamp, row: decode.display(b.payload, true).values })) });
  }
}
const schools = ['physical', 'magic', 'true'];
const ids = fieldsOf('display', 'id');
function agrees(binding) {
  let changed = false;
  for (const [id, start] of frames) {
    const end = frames.get(id + 1);
    if (!end) continue;
    const window = new Map();
    for (const n of [2 * id + 1, 2 * id + 2]) {
      const chunk = chunks.get(n);
      if (!chunk) throw new Error('Missing replay chunk between keyframes');
      const hits = [];
      for (const { time, row } of chunk.hits) {
        const amount = row[binding.amount];
        if (!Number.isFinite(amount) || amount < 0) return false;
        if (amount > 0) hits.push({ time, amount, school: schools[row[binding.typeCode]],
          sourceId: row[binding.sourceId], targetId: row[binding.targetId] });
      }
      window.set(n, { end: chunk.end, hits });
    }
    const totals = teamTotalsAt(start, window);
    for (const [hero, truth] of end.heroes) {
      for (const field of ['damageToChampions', 'damageTaken']) {
        for (const school of ['total', ...schools]) {
          if (Math.abs(totals.heroes.get(hero)[field][school] - truth[field][school]) > 0.5) return false;
          if (truth[field][school] > start.heroes.get(hero)[field][school] + 0.5) changed = true;
        }
      }
    }
  }
  return changed;
}
const bindings = [];
for (const sourceId of ids) for (const targetId of ids) {
  if (sourceId === targetId) continue;
  for (const amount of fieldsOf('display', 'float')) for (const typeCode of fieldsOf('display', 'u8')) {
    const candidate = { sourceId, targetId, amount, typeCode };
    if (agrees(candidate)) bindings.push(candidate);
  }
}
if (!spawnCount || models.length !== 1 || bindings.length !== 1) {
  throw new Error(`Replay left ${models.length} model and ${bindings.length} display bindings. Check IDs, framing and replay coverage.`);
}
const display = Object.fromEntries(Object.entries(bindings[0]).map(([name, offset]) => [name, Number(offset)]));
console.log(JSON.stringify({ heroSpawn: { model: Number(models[0]) }, display }));
