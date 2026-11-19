import { readReplay } from './teamChunks16_22.mjs';
import { parseBlocks } from '../src/core/spectator/block-parser.js';
import { BlockFramingError } from '../src/core/spectator/errors.js';

// Keep only counts and entity IDs. A full game has hundreds of thousands of blocks.
function inventory(segments, secondaryTimestamp) {
  const frames = [];
  const chunks = new Map();
  for (const { type, data } of segments) {
    if (type !== 1 && type !== 2) continue;
    const frame = new Map();
    for (const { packetId, param, length } of parseBlocks(data, { secondaryTimestamp })) {
      if (type === 1) {
        if (!chunks.has(packetId)) chunks.set(packetId, new Set());
        chunks.get(packetId).add(param);
      } else {
        if (!frame.has(packetId)) frame.set(packetId, []);
        frame.get(packetId).push({ param, length });
      }
    }
    if (type === 2) frames.push(frame);
  }
  if (frames.length < 2 || !chunks.size) throw new Error('Use a full replay with consecutive keyframes and damage');
  const heroStats = [];
  const heroSpawn = [];
  for (const id of frames[0].keys()) {
    const groups = frames.map(frame => frame.get(id) ?? []);
    if (!groups.every(rows => rows.length === 10)) continue;
    if (groups.every(rows => rows.every(r => r.length === 1263) && new Set(rows.map(r => r.param)).size === 10)) {
      heroStats.push(id);
    }
    if (groups.every(rows => rows.every(r => r.param === 0))) heroSpawn.push(id);
  }
  const heroes = new Set(heroStats.flatMap(id => frames[0].get(id).map(r => r.param)));
  const display = [...chunks].filter(([, owners]) => [...heroes].some(id => owners.has(id))).map(([id]) => id);
  return { secondaryTimestamp, heroStats, heroSpawn, display };
}

const replay = readReplay(process.argv[2]);
const choices = [];
for (const flag of [false, true]) {
  try {
    const found = inventory(replay.segments, flag);
    if (found.heroStats.length && found.heroSpawn.length && found.display.length) choices.push(found);
  } catch (error) {
    if (!(error instanceof BlockFramingError)) throw error;
  }
}
if (choices.length !== 1) throw new Error('No unique supported observer framing and roster. Check the replay and block format.');
console.log(JSON.stringify({ build: replay.build, ...choices[0] }));
