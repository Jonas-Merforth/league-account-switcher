// Dumps every application packet type of a saved Damage recording, capped
// per type, with how often each type occurred. Use it to compare the
// generic schema decoder with the hand-written readers on real payloads and
// to find a role's packet ID on a new build by its statistics.
// The output holds game packets only. Keep it in ignored storage anyway.
//
// node research/dumpAllLivePackets.mjs <session-directory> <out.json> [cap-per-type=400] [profile.json]
//
// Unknown builds yield outer packets only, using the transport checksum.
// Supply a matching generated profile as the last argument to expand batches.
import fs from 'node:fs';
import path from 'node:path';
import { DamageLive } from '../src/core/damageLive.js';
import { damageBuildFromLog, DamageWire, readDamageTransport } from '../src/core/damageWire.js';
import { protocolForBuild } from '../src/core/liveProtocol.js';
import { schemaFields } from '../src/core/liveSchemaFields.js';

const [dir, out, capText, profileFile] = process.argv.slice(2);
if (!dir || !out) {
  console.error('Usage: node research/dumpAllLivePackets.mjs <session-directory> <out.json> [cap-per-type] [profile.json]');
  process.exit(1);
}
const cap = Number(capText ?? 400);
if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('Expected a positive sample cap');
const live = new DamageLive(path.join(dir, 'raw-ipv4.pcapng'), 10, {});
live.maxReadPasses = Infinity;
const log = fs.readFileSync(path.join(dir, 'original-r3dlog.txt'), 'utf8').slice(0, 65536);
const build = damageBuildFromLog(log);
const transport = readDamageTransport(log);
if (!build || !transport) throw new Error('Missing build or session data in the game log');
let protocol = protocolForBuild(build);
if (profileFile) {
  const profile = JSON.parse(fs.readFileSync(profileFile));
  if (profile.build !== build) throw new Error('Recording and candidate profile builds differ');
  protocol = { ...profile.ids, fields: schemaFields(profile) };
}
live.server = transport.server;
live.serverPort = transport.port;
// Only the batch role is needed to inventory inner packets.
live.wire = new DamageWire({ ...transport, protocol: { batch: protocol?.batch, fields: protocol?.fields } });
const payloads = {};
const counts = {};
const times = {};
let startedAt;
const dispatch = live.wire.dispatch.bind(live.wire);
// dispatch sees batches and the packets inside them, which onPacket does not.
live.wire.dispatch = (data, direction, id, time, depth) => {
  if (!data.length || (data[0] >= 251 && data.length < 2)) return dispatch(data, direction, id, time, depth);
  const size = data[0] < 251 ? 1 : 2;
  const type = size === 1 ? data[0] : 251 + (data[0] - 251) * 256 + data[1];
  const key = `${direction}:${type}`;
  counts[key] = (counts[key] ?? 0) + 1;
  startedAt ??= time;
  const list = payloads[key] ??= [];
  if (list.length < cap) {
    list.push(Buffer.from(data.subarray(size)).toString('hex'));
    (times[key] ??= []).push(time - startedAt);
  }
  return dispatch(data, direction, id, time, depth);
};
live.poll({ final: true });
if (!Object.keys(counts).length) throw new Error('No application packets recovered. Check the capture and transport framing.');
fs.writeFileSync(out, JSON.stringify({ build, expandedBatches: !!protocol, counts, payloads, times }), { flag: 'wx' });
console.log(build, protocol ? 'including batches' : 'outer packets only', Object.keys(counts).length, 'types', JSON.stringify(live.wire.stats));
