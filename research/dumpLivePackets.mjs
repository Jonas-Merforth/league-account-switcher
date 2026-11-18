// Dumps the raw bodies of chosen playing-client packet types from a saved
// Damage recording, for offline work with the pinned macOS deserializers.
// The output holds game packets only. Keep it in ignored storage anyway.
//
// node research/dumpLivePackets.mjs <session-directory> <out.json> <type> [type ...]
import fs from 'node:fs';
import path from 'node:path';
import { DamageLive } from '../src/core/damageLive.js';

const [dir, out, ...types] = process.argv.slice(2);
if (!dir || !out || !types.length) {
  console.error('Usage: node research/dumpLivePackets.mjs <session-directory> <out.json> <type> [type ...]');
  process.exit(1);
}
const wanted = new Set(types.map(Number));
const payloads = Object.fromEntries(types.map((type) => [`in:${Number(type)}`, []]));
const live = new DamageLive(path.join(dir, 'raw-ipv4.pcapng'), 10, {});
live.maxReadPasses = Infinity;
live.initialize(fs.readFileSync(path.join(dir, 'original-r3dlog.txt'), 'utf8').slice(0, 65536));
if (!live.wire) throw new Error('No session data in the game log');
const inner = live.wire.onPacket;
live.wire.onPacket = (packet) => {
  inner(packet);
  if (packet.direction !== 'in' || !wanted.has(packet.type)) return;
  const list = payloads[`in:${packet.type}`];
  if (list.length < 20000) list.push([packet.time, Buffer.from(packet.fields).toString('hex')]);
};
live.poll({ final: true });
fs.writeFileSync(out, JSON.stringify({ build: live.protocol.build, payloads }), { flag: 'wx' });
console.log(Object.entries(payloads).map(([type, list]) => `${type}: ${list.length}`).join(', '));
