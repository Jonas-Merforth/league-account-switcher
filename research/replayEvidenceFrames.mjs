import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readReplay } from './teamChunks16_22.mjs';

const [recording, replay, destination, expectedBuild] = process.argv.slice(2);
const meta = JSON.parse(readFileSync(join(recording, 'summary.json'))).replayMetadata;
if (!meta || basename(replay).toLowerCase() !== (meta.platformId + '-' + meta.gameId + '.rofl').toLowerCase()) {
  throw new Error('Replay and Match History game identities differ');
}
const { build, segments } = readReplay(replay);
if (build !== expectedBuild) throw new Error('Replay build differs from recording');
mkdirSync(destination);
writeFileSync(join(destination, 'manifest.json'), JSON.stringify({ build, queueId: meta.queueId }));
for (const segment of segments.filter(s => s.type === 2)) {
  writeFileSync(join(destination, 'keyframe-' + segment.id + '.bin'), segment.data, { flag: 'wx' });
}
