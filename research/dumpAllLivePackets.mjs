// Dumps every application packet type of a saved Damage recording, capped
// per type, with how often each type occurred. Use it to compare the
// generic schema decoder with the hand-written readers on real payloads and
// to find a role's packet ID on a new build by its statistics.
// The output holds game packets only. Keep it in ignored storage anyway.
//
// node research/dumpAllLivePackets.mjs <session-directory> <out.json> [cap-per-type=400]
//
// The recording's build must already be in src/core/liveProtocol.js, because
// the transport reader is selected from the game log.
import fs from 'node:fs';
import path from 'node:path';
import { DamageLive } from '../src/core/damageLive.js';

const [dir, out, capText] = process.argv.slice(2);
if (!dir || !out) {
  console.error('Usage: node research/dumpAllLivePackets.mjs <session-directory> <out.json> [cap-per-type]');
  process.exit(1);
}
const cap = Number(capText ?? 400);
const live = new DamageLive(path.join(dir, 'raw-ipv4.pcapng'), 10, {});
live.maxReadPasses = Infinity;
live.initialize(fs.readFileSync(path.join(dir, 'original-r3dlog.txt'), 'utf8').slice(0, 65536));
if (!live.wire) throw new Error('No session data in the game log');
const payloads = {};
const counts = {};
const dispatch = live.wire.dispatch.bind(live.wire);
// dispatch sees batches and the packets inside them, which onPacket does not.
live.wire.dispatch = (data, direction, id, time, depth) => {
  const size = data[0] < 251 ? 1 : 2;
  const type = size === 1 ? data[0] : 251 + (data[0] - 251) * 256 + data[1];
  const key = `${direction}:${type}`;
  counts[key] = (counts[key] ?? 0) + 1;
  const list = payloads[key] ??= [];
  if (list.length < cap) list.push(Buffer.from(data.subarray(size)).toString('hex'));
  return dispatch(data, direction, id, time, depth);
};
live.poll({ final: true });
fs.writeFileSync(out, JSON.stringify({ build: live.protocol.build, counts, payloads }), { flag: 'wx' });
console.log(live.protocol.build, Object.keys(counts).length, 'types', JSON.stringify(live.wire.stats));
