// Replays a League replay (.rofl, format 2) through the Team damage feed and
// checks the chunk totals against the replay's own keyframes and final stats.
// A replay holds the same keyframes and 30-second chunks as the live
// spectator feed, so this exercises the decoder the app uses during a game.
//
// node research/teamChunks16_22.mjs '<path to .rofl>' [...]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decompress } from 'fzstd';
import { decodeTeamChunk, decodeTeamKeyframe, teamTotalsAt } from '../src/core/damageTeam.js';

const SCORES = [['damageToChampions', 'TOTAL_DAMAGE_DEALT_TO_CHAMPIONS'], ['damageTaken', 'TOTAL_DAMAGE_TAKEN']];

export function readReplay(file) {
  const data = fs.readFileSync(file);
  if (data.toString('latin1', 0, 4) !== 'RIOT' || data.readUInt16LE(4) !== 2) throw new Error('Not a format 2 replay');
  const build = data.toString('latin1', 15, 15 + data[14]);
  const metadataLength = data.readUInt32LE(data.length - 4);
  const metadata = JSON.parse(data.toString('utf8', data.length - 4 - metadataLength, data.length - 4));
  const end = data.length - 4 - metadataLength - 256;
  const segments = [];
  for (let offset = 15 + data[14]; offset < end;) {
    const id = data.readUInt32LE(offset);
    const type = data[offset + 8];
    const size = data.readUInt32LE(offset + 9);
    const packed = data.readUInt32LE(offset + 13);
    const body = data.subarray(offset + 18, offset + 18 + (packed || size));
    segments.push({ id, type, data: packed ? Buffer.from(decompress(body)) : body });
    offset += 18 + (packed || size);
  }
  return { build, metadata, segments };
}

const within = (a, b) => Math.abs(a - b) <= 0.5;

function checkReplay(file) {
  const { build, metadata, segments } = readReplay(file);
  const keyframes = new Map();
  const chunks = new Map();
  let rows = 0;
  let rejected = 0;
  for (const segment of segments) {
    if (segment.type === 2) keyframes.set(segment.id, { keyFrameId: segment.id, ...decodeTeamKeyframe(segment.data) });
    else if (segment.type === 1) {
      const chunk = decodeTeamChunk(segment.data);
      rows += chunk.rows;
      rejected += chunk.rejected;
      chunks.set(segment.id, chunk);
    }
  }
  console.log(`\n## ${path.basename(file)} build ${build}: ${keyframes.size} keyframes, ${chunks.size} chunks, ` +
    `${rows} damage rows, ${rejected} rejected`);

  // As the live feed sees it: keyframe K plus chunks 2K+1 and 2K+2 must
  // reproduce keyframe K+1, whose time is the end of chunk 2K+2.
  const checks = Object.fromEntries(SCORES.map(([field]) => [field, { match: 0, total: 0, worst: 0 }]));
  for (const [id, anchor] of keyframes) {
    const next = keyframes.get(id + 1);
    if (!next) continue;
    const window = new Map([2 * id + 1, 2 * id + 2].filter((chunkId) => chunks.has(chunkId)).map((chunkId) => [chunkId, chunks.get(chunkId)]));
    const totals = teamTotalsAt(anchor, window);
    for (const [heroId, truth] of next.heroes) {
      for (const [field] of SCORES) {
        const difference = Math.abs(totals.heroes.get(heroId)[field].total - truth[field].total);
        checks[field].total++;
        if (difference <= 0.5) checks[field].match++;
        checks[field].worst = Math.max(checks[field].worst, difference);
      }
    }
  }
  for (const [field, check] of Object.entries(checks)) {
    console.log(`  ${field.padEnd(18)} chunk totals equal the next keyframe for ${check.match}/${check.total} hero-keyframes ` +
      `(largest difference ${check.worst.toFixed(2)})`);
  }

  // The last keyframe plus the remaining chunks against League's final stats.
  const last = keyframes.get(Math.max(...keyframes.keys()));
  const final = teamTotalsAt(last, chunks);
  const players = JSON.parse(metadata.statsJson || '[]');
  const ids = [...final.heroes.keys()].sort((a, b) => a - b);
  if (players.length === ids.length) {
    for (const [field, stat] of SCORES) {
      const matched = ids.filter((id, index) => final.heroes.get(id).team === Number(players[index].TEAM) &&
        within(Math.trunc(final.heroes.get(id)[field].total), Number(players[index][stat]))).length;
      console.log(`  ${field.padEnd(18)} final totals equal the replay's end-of-game stats for ${matched}/${ids.length} players`);
    }
    for (const [index, id] of ids.entries()) {
      const hero = final.heroes.get(id);
      console.log(`    ${String(players[index].SKIN).padEnd(14)} to champions ${Math.round(hero.damageToChampions.total).toString().padStart(7)}` +
        ` (League ${players[index].TOTAL_DAMAGE_DEALT_TO_CHAMPIONS})`);
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.argv.slice(2).forEach(checkReplay);
