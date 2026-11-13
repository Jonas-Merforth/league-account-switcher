import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { indexPcap, udpMetadata } from '../src/core/ffPcap.js';

function dir(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-packet-test-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
function frame() {
  const b = Buffer.alloc(46); b.writeUInt16BE(0x0800, 12); b[14] = 0x45; b.writeUInt16BE(32, 16); b[23] = 17;
  b.set([10, 0, 0, 1, 10, 0, 0, 2], 26); b.writeUInt16BE(5000, 34); b.writeUInt16BE(6000, 36); b.writeUInt16BE(12, 38); b.write('test', 42); return b;
}
function pcap() {
  const block = (type, body) => { const b = Buffer.alloc(12 + Math.ceil(body.length / 4) * 4); b.writeUInt32LE(type); b.writeUInt32LE(b.length, 4); body.copy(b, 8); b.writeUInt32LE(b.length, b.length - 4); return b; };
  const section = Buffer.alloc(16); section.writeUInt32LE(0x1a2b3c4d); section.writeUInt16LE(1, 4); section.writeBigInt64LE(-1n, 8);
  const iface = Buffer.alloc(8); iface.writeUInt16LE(1); iface.writeUInt32LE(65535, 4);
  const epb = Buffer.alloc(20 + frame().length); epb.writeUInt32LE(1000000, 8); epb.writeUInt32LE(frame().length, 12); epb.writeUInt32LE(frame().length, 16); frame().copy(epb, 20);
  return Buffer.concat([block(0x0a0d0d0a, section), block(1, iface), block(6, epb)]);
}
test('PCAPNG validates full packet bytes, clock, UDP direction and malformed blocks', (t) => {
  const d = dir(t); const file = path.join(d, 'capture.pcapng'); fs.writeFileSync(file, pcap());
  const index = path.join(d, 'index.jsonl'); const summary = indexPcap(file, index, [5000]);
  assert.equal(summary.packets, 1); assert.equal(summary.udpPackets, 1); assert.equal(summary.firstPacketAt, 1000);
  const row = JSON.parse(fs.readFileSync(index)); assert.equal(row.direction, 'outgoing'); assert.equal(row.payloadBytes, 4); assert.equal(row.payloadTruncated, false);
  const bad = pcap(); bad.writeUInt32LE(0xffffffff, 4); fs.writeFileSync(file, bad);
  assert.throws(() => indexPcap(file, path.join(d, 'bad.jsonl')), /block length/);
  const fragment = frame(); fragment.writeUInt16BE(0x2000, 20); assert.equal(udpMetadata(fragment, 1).protocol, 'unsupported');
});
