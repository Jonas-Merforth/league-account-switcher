import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePatch1619HeroSnapshotPayload, decodePatch1619HeroStats,
  decodePatch1619RosterPayload, decodePatch1619TurretSnapshot
} from '../src/core/spectator/patch-16-19-codecs.js';
import { KeyframeSnapshotDecoder } from '../src/core/spectator/keyframe-snapshot-decoder.js';

// Oracle-confirmed byte permutation at macOS VA 0x101416520. Kept independent
// of the production module, with fixed wire examples below to catch drift.
const TABLE = Buffer.from(
  'd75682dc83028f2935042171799e927fcb976a5105c76fe640637e345b4707785a'
  + '96b8b92c995e6ed1754161245f4aaa4bcf0ed4865dba1d3f2bdf62f0330055ca'
  + 'fc19acf3662369bceb46f89c50874d6d108e88be1bb5da4e1a13cc2209ada49d'
  + '30a6e57dfac91712c2fde1bbe70b98bfbd1137c07cf795b6dd49f4812a9f1cfb'
  + '8d9a727b577a43b3a953e459202fa8f67436a085f1a7147031840cb2a5dbe816'
  + 'ae3d25b1cd9b0367155cea1f39a1440a8b76de606593f264d5c1c84c064fb7ed'
  + 'fee0f9a2184891ce1e3cb46c425494e328e90127ec0d45ff26efe28aabd9f508c'
  + '4af32c56b80c6c358eea33e2d0f893ab0d2d33873d8d08c7790523bd62e68', 'hex'
);
const inverse = new Map(Array.from({ length: 256 }, (_, byte) => {
  const added = (byte + 17) & 255;
  const rotated = ((added << 6) | (added >>> 2)) & 255;
  const swapped = ((rotated & 0x55) << 1) | ((rotated & 0xaa) >>> 1);
  return [(TABLE[swapped] + 57) & 255, byte];
}));
function heroPayload(vector) {
  return Buffer.from([0x67, 0x00, 0xde, ...Array.from(vector).reverse().map((v) => inverse.get(v))]);
}

// Public champion labels only: no raw roster, account or game identifiers.
// Fixed canonical field encodings were checked against the executable.
const STRINGS = [
  ['Zyra', '92e2cdb7e8'], ['Zeri', '9253cd04e8'],
  ['Sylas', 'd330ddeecfe3'], ['Shaco', '3cd4d7e29eac'],
  ['Smolder', 'c090f1deeeeb48e3'], ['Nautilus', 'f3309dee4bf59ddd25'],
  ['Aphelios', '35a177e2ea4e00ec08'], ['Ahri', 'cea1004ec2'],
  ['Sejuani', '024400ec2d5a90a3'], ['Renekton', '350e2decea2da8ec5f']
];
function rosterPayload() {
  const payload = Buffer.alloc(1_050);
  STRINGS.forEach(([, hex], index) => Buffer.from(hex, 'hex').copy(payload, 30 + 100 * index));
  return payload;
}
const BLUE = [0x88, 0x8b, 0x8c, 0x8d, 0x8e, 0x94, 0x9a, 0xa2, 0xa3, 0xa6, 0xab];
const RED = [0x92, 0x93, 0x96, 0x97, 0x98, 0x9b, 0xa0, 0xa1, 0xa4, 0xa5, 0xa7];
function turrets(destroyed = []) {
  return [...BLUE, ...RED].map((id, index) => {
    const payload = Buffer.alloc(index % 2 ? 47 : 63);
    Buffer.from(destroyed.includes(id) ? '002ff5' : '8f24f4', 'hex').copy(payload);
    return { packetId: 1099, param: 0x40000000 + id, length: payload.length, payload };
  });
}

test('16.19 hero vector retains all 256 byte values and reverse write order', () => {
  assert.equal(inverse.size, 256);
  const vector = Buffer.from(Array.from({ length: 1260 }, (_, i) => i & 255));
  assert.deepEqual(decodePatch1619HeroSnapshotPayload(heroPayload(vector)), vector);
});

test('16.19 hero stats and objective offsets decode absolute values', () => {
  const vector = Buffer.alloc(1260);
  vector.writeUInt32LE(200, 0x20);
  vector.writeFloatLE(13_020, 0x28);
  vector.writeFloatLE(121, 0x3c);
  vector.writeFloatLE(19, 0x40);
  for (const [offset, value] of [[0x4c, 9], [0x50, 4], [0x54, 11], [0xa4, 1], [0xa8, 2],
    [0xac, 1], [0xb0, 1], [0xb4, 3], [0xb8, 1]]) vector.writeUInt32LE(value, offset);
  const result = decodePatch1619HeroStats(heroPayload(vector));
  assert.equal(result.teamId, 200);
  assert.equal(result.level, 15);
  assert.deepEqual(result.score, { kills: 9, deaths: 4, assists: 11, cs: 140 });
  assert.deepEqual(result.credits, { inhibitorsKilled: 0, inhibitorTakedowns: 0,
    turretsKilled: 0, turretTakedowns: 0, barons: 1, dragons: 2, elderDragons: 1,
    riftHeralds: 1, voidGrubs: 3, atakhan: 1 });
});

test('16.19 rejects old tags, truncated or oversized vectors and malformed length fields', () => {
  const valid = heroPayload(Buffer.alloc(1260));
  for (const input of [valid.subarray(1), Buffer.concat([valid, Buffer.from([0])]),
    Buffer.from([0xcb, ...valid.subarray(1)]), Buffer.from([0x67, 0xff, ...valid.subarray(2)])]) {
    assert.throws(() => decodePatch1619HeroSnapshotPayload(input));
  }
  const badTeam = Buffer.alloc(1260);
  assert.throws(() => decodePatch1619HeroStats(heroPayload(badTeam)), /team id/);
  badTeam.writeUInt32LE(100, 0x20);
  for (const value of [NaN, Infinity, -1]) {
    badTeam.writeFloatLE(value, 0x28);
    assert.throws(() => decodePatch1619HeroStats(heroPayload(badTeam)), /experience/);
  }
});

test('16.19 canonical roster reverses records, reverse strings and outside-in strings', () => {
  assert.deepEqual(decodePatch1619RosterPayload(rosterPayload()).map((r) => r.championName),
    STRINGS.map(([name]) => name).reverse());
  assert.throws(() => decodePatch1619RosterPayload(Buffer.alloc(799)), /shape/);
  assert.throws(() => decodePatch1619RosterPayload(Buffer.alloc(1301)), /shape/);
  const missing = rosterPayload();
  missing.fill(0, 30, 40);
  assert.throws(() => decodePatch1619RosterPayload(missing), /9 champion rows/);
  const extra = rosterPayload();
  Buffer.from(STRINGS[0][1], 'hex').copy(extra, 10);
  assert.throws(() => decodePatch1619RosterPayload(extra), /11 champion rows/);
});

test('16.19 turret counts credit the opposing team', () => {
  assert.deepEqual(decodePatch1619TurretSnapshot(turrets([0x88, 0x8b, 0x92])), { 100: 1, 200: 2 });
  assert.equal(decodePatch1619TurretSnapshot([]), null);
  assert.throws(() => decodePatch1619TurretSnapshot(turrets().slice(1)), /expected 22/);
  const duplicate = turrets();
  duplicate[1] = duplicate[0];
  assert.throws(() => decodePatch1619TurretSnapshot(duplicate), /duplicate/);
});

test('16.19 turret decoder rejects corrupt selectors, padding, lengths and state disagreement', () => {
  for (const mutate of [
    (b) => b.payload.fill(0), (b) => b.payload.fill(255),
    (b) => { b.payload[0] ^= 0x40; }, (b) => { b.payload[1] ^= 0x10; },
    (b) => { b.payload[2] &= 15; }, (b) => { b.payload[0] ^= 1; },
    (b) => { b.payload[0] ^= 0x80; }, (b) => { b.payload[1] ^= 8; },
    (b) => { b.length--; },
    (b) => { b.payload = Buffer.alloc(46); b.length = 46; },
    (b) => { b.payload = Buffer.alloc(64); b.length = 64; }
  ]) {
    const blocks = turrets(); mutate(blocks[0]);
    assert.throws(() => decodePatch1619TurretSnapshot(blocks));
  }
});

test('production registration decodes the complete 16.19 grammar and fails closed across versions/modes', () => {
  const payload = rosterPayload();
  const blocks = [{ packetId: 453, param: 0, length: payload.length, payload, timestamp: 600 },
    ...turrets(), ...Array.from({ length: 10 }, (_, slot) => {
      const vector = Buffer.alloc(1260); vector.writeUInt32LE(slot < 5 ? 100 : 200, 0x20);
      const payload = heroPayload(vector);
      return { packetId: 137, param: 0x400000ae + slot, length: payload.length, payload, timestamp: 600 };
    })];
  for (let slot = 0; slot < 10; slot++) for (let family = 0; family < 10; family++) {
    blocks.push({ packetId: 2000 + family, param: 0x400000ae + slot,
      payload: Buffer.alloc(1), length: 1, timestamp: 600 });
  }
  const decoder = new KeyframeSnapshotDecoder();
  for (const queueId of [400, 420, 440, 2400]) {
    const result = decoder.decode({ blocks, queueId, clientVersion: '16.19.821.7343' });
    assert.match(result.profileId, /^league-16\.19-/);
    assert.equal(result.participants[0].championId, 58);
    assert.equal(result.capabilities.items, 'unavailable');
  }
  for (const version of ['16.18.817.5716', '16.20.1', '116.19.1']) {
    assert.throws(() => decoder.decode({ blocks, queueId: 420, clientVersion: version }));
  }
  assert.throws(() => decoder.decode({ blocks, queueId: 450, clientVersion: '16.19.821.7343' }));
  const bad = blocks.map((b) => b.packetId === 137 ? { ...b, payload: Buffer.alloc(b.length) } : b);
  assert.throws(() => decoder.decode({ blocks: bad, queueId: 440, clientVersion: '16.19.821.7343' }));
});
