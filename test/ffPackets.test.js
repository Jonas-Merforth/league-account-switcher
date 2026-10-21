import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { indexPcap, udpMetadata } from '../src/core/ffPcap.js';
import { surrenderSystemMessage } from '../src/core/ffChatEvidence.js';
import { analyzePacketCapture, clockEstimate } from '../src/core/ffPacketAnalysis.js';
import { FFResearchService } from '../src/core/ffResearch.js';

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
test('chat only accepts system notifications; phases remain distinct and names are not retained', () => {
  assert.equal(surrenderSystemMessage({ type: 'chat', body: 'surrender vote passed' }), null);
  const started = surrenderSystemMessage({ type: 'system', body: 'PrivateName has started a surrender vote', timestamp: '2026-10-17T12:00:00Z' });
  assert.equal(started.stage, 'vote-start'); assert.equal(started.side, 'unknown'); assert.ok(!JSON.stringify(started).includes('PrivateName'));
  assert.equal(surrenderSystemMessage({ type: 'system', body: 'The surrender vote failed' }).stage, 'vote-failed');
  assert.equal(surrenderSystemMessage({ type: 'system', body: 'The surrender vote passed' }).stage, 'surrender-accepted');
});
test('chat history and live system clues remain alignment candidates, not enemy detections', (t) => {
  const d = dir(t); const service = new FFResearchService({ getLeaguePath: () => d, getOutputDir: () => d, getCredentials: () => ({}), schedule: false });
  service.start();
  service.ingestChatMessage({ type: 'system', id: 'one', body: 'A started a surrender vote' }, true);
  service.ingestChatMessage({ type: 'system', id: 'one', body: 'A started a surrender vote' }, false);
  service.ingestChatMessage({ type: 'system', id: 'two', body: 'The surrender vote failed' }, false);
  const rows = service.rows.filter(r => r.kind === 'alignment-candidate'); assert.equal(rows.length, 2); assert.equal(rows[0].historical, true);
  assert.equal(service.snapshot().timing.candidateCount, 0); service.stop();
});
test('packet alignment uses manual game time, reports duplicate candidates and refuses distant anchors', async (t) => {
  const d = dir(t); const capture = path.join(d, 'test.jsonl'); const index = path.join(d, 'index.jsonl');
  const anchor = { kind: 'sample', matchIndex: 1, data: { clockAnchor: { requestedAt: new Date(100000).toISOString(), receivedAt: new Date(100100).toISOString(), gameTime: 539 } } };
  const marker = { kind: 'marker', id: 2, matchIndex: 1, stage: 'vote-start', side: 'ally', receivedAt: new Date(110000).toISOString(), data: { observedGameTime: 539 } };
  fs.writeFileSync(capture, [anchor, marker].map(JSON.stringify).join('\n'));
  fs.writeFileSync(index, [0, 1].map(i => JSON.stringify({ packet: i + 1, unixMs: 100050 + i, capturedLength: 80, frameHash: 'same', direction: 'incoming', protocol: 'UDP' })).join('\n'));
  const report = await analyzePacketCapture(capture, index);
  assert.equal(report.observations[0].packets, 2); assert.equal(report.observations[0].unixMs, 100050); assert.equal(report.possibleDuplicates, 1);
  assert.equal(clockEstimate(120000, [{ midpoint: 100050, gameTime: 539, matchIndex: 1 }]), null);
});

test('recorder stops the packet helper, blocks premature exports, and includes its result', (t) => {
  const d = dir(t); let stops = 0; let exported = 0;
  const packets = { busy: false, state: { state: 'off' },
    start() { this.busy = true; this.state = { state: 'capturing' }; },
    stop() { stops++; }, export() { exported++; return 'companion.packets'; } };
  const service = new FFResearchService({ getLeaguePath: () => d, getOutputDir: () => d, getCredentials: () => ({}), schedule: false, packetCapture: packets });
  service.start({ packets: true });
  assert.throws(() => service.exportCapture(path.join(d, 'out.jsonl')), /conversion/);
  service.stop(); assert.equal(stops, 1);
  assert.throws(() => service.start(), /previous packet/);
  packets.busy = false; packets.state = { state: 'complete', validation: { packets: 12 } };
  const result = service.exportCapture(path.join(d, 'out.jsonl'));
  assert.equal(result.packetDirectory, 'companion.packets'); assert.equal(exported, 1);
  const rows = fs.readFileSync(result.filePath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).data.packets.validation.packets, 12);
  service.start({ packets: false }); service.stop(); assert.equal(stops, 1); assert.equal(service.snapshot().packets, null);
});

test('chat room probe excludes DMs, marks first history, and ignores an in-flight response after stop', async (t) => {
  const d = dir(t); const requests = []; let phase = 0;
  const readJson = async ({ endpoint }) => {
    requests.push(endpoint);
    if (endpoint.endsWith('/conversations')) return [{ id: 'direct', type: 'chat' }, { id: 'room', type: 'customGame' }];
    return [{ id: phase, type: 'system', body: phase ? 'The surrender vote failed' : 'Private started a surrender vote' }];
  };
  const service = new FFResearchService({ getLeaguePath: () => d, getOutputDir: () => d, getCredentials: () => ({ pid: 1, port: 2 }), schedule: false, readJson });
  service.start(); await service.pollChat(); phase++; await service.pollChat();
  assert.ok(!requests.some(s => s.includes('direct/messages')));
  const clues = service.rows.filter(r => r.kind === 'alignment-candidate'); assert.equal(clues[0].historical, true); assert.equal(clues[1].historical, false);
  let resolve; service.readJson = () => new Promise(r => { resolve = r; }); const pending = service.pollChat(); service.stop();
  const count = service.sequence; resolve([]); await pending; assert.equal(service.sequence, count);
});
