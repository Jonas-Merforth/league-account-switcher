import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePatch1620HeroSnapshotPayload, decodePatch1620HeroStats,
  decodePatch1620RosterPayload, decodePatch1620TurretSnapshot
} from '../src/core/spectator/patch-16-20-codecs.js';
import { KeyframeSnapshotDecoder } from '../src/core/spectator/keyframe-snapshot-decoder.js';

// Independently transcribed VA 0x10131b530 permutation; fixed length bytes
// and public champion encodings below were confirmed by executable emulation.
const inverse = new Map(Array.from({ length: 256 }, (_, byte) => {
  let value = byte ^ 255;
  value = ((value << 1) | (value >>> 7)) & 255;
  value = (value + 149) & 255;
  value = ((value << 3) | (value >>> 5)) & 255;
  value = (77 - value) & 255;
  value = ((value << 6) | (value >>> 2)) & 255;
  return [value, byte];
}));
function heroPayload(vector) {
  return Buffer.from([0x65, 0xa0, 0xb7, ...Array.from(vector).reverse().map((v) => inverse.get(v))]);
}

// Public champion labels only: no raw roster, account or game identifiers.
// Fixed canonical field encodings were checked against the executable.
const STRINGS = [
  ['Rumble', '4f8a092acbe29c'], ['Ekko', '7623939385'],
  ['Leblanc', '503bafc1092a8aeb'], ['Caitlyn', '50afe609b0bac1f0'],
  ['Qiyana', '3646c6f21bcd1b'], ['Zilean', '3623c6e3141bcd'],
  ['Singed', '362dc6cdb5141a'], ['Leblanc', 'b2f3148ee31bcd63'],
  ['Caitlyn', '3fd2d0e2c4a027be'], ['MonkeyKing', '5635d2a0eed0c05fd257b6']
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
    Buffer.from(destroyed.includes(id) ? 'df9202' : 'd09408', 'hex').copy(payload);
    return { packetId: 1200, param: 0x40000000 + id, length: payload.length, payload };
  });
}

test('16.20 hero vector retains all 256 byte values and reverse write order', () => {
  assert.equal(inverse.size, 256);
  const vector = Buffer.from(Array.from({ length: 1260 }, (_, i) => i & 255));
  assert.deepEqual(decodePatch1620HeroSnapshotPayload(heroPayload(vector)), vector);
});

test('16.20 hero stats and objective offsets decode absolute values', () => {
  const vector = Buffer.alloc(1260);
  vector.writeUInt32LE(200, 0x20);
  vector.writeFloatLE(13_020, 0x28);
  vector.writeFloatLE(121, 0x3c);
  vector.writeFloatLE(19, 0x40);
  for (const [offset, value] of [[0x4c, 9], [0x50, 4], [0x54, 11], [0xa4, 1], [0xa8, 2],
    [0xac, 1], [0xb0, 1], [0xb4, 3], [0xb8, 1]]) vector.writeUInt32LE(value, offset);
  const result = decodePatch1620HeroStats(heroPayload(vector));
  assert.equal(result.teamId, 200);
  assert.equal(result.level, 15);
  assert.deepEqual(result.score, { kills: 9, deaths: 4, assists: 11, cs: 140 });
  assert.deepEqual(result.credits, { inhibitorsKilled: 0, inhibitorTakedowns: 0,
    turretsKilled: 0, turretTakedowns: 0, barons: 1, dragons: 2, elderDragons: 1,
    riftHeralds: 1, voidGrubs: 3, atakhan: 1 });
});

test('16.20 rejects old tags, truncated or oversized vectors and malformed length fields', () => {
  const valid = heroPayload(Buffer.alloc(1260));
  for (const input of [valid.subarray(1), Buffer.concat([valid, Buffer.from([0])]),
    Buffer.from([0xcb, ...valid.subarray(1)]), Buffer.from([0x67, ...valid.subarray(1)]),
    Buffer.from([0x65, 0xff, ...valid.subarray(2)])]) {
    assert.throws(() => decodePatch1620HeroSnapshotPayload(input));
  }
  const badTeam = Buffer.alloc(1260);
  assert.throws(() => decodePatch1620HeroStats(heroPayload(badTeam)), /team id/);
  badTeam.writeUInt32LE(100, 0x20);
  for (const value of [NaN, Infinity, -1]) {
    badTeam.writeFloatLE(value, 0x28);
    assert.throws(() => decodePatch1620HeroStats(heroPayload(badTeam)), /experience/);
  }
});

test('16.20 canonical roster preserves records with reverse A/B and forward C strings', () => {
  assert.deepEqual(decodePatch1620RosterPayload(rosterPayload()).map((r) => r.championName),
    STRINGS.map(([name]) => name));
  assert.throws(() => decodePatch1620RosterPayload(Buffer.alloc(799)), /shape/);
  assert.throws(() => decodePatch1620RosterPayload(Buffer.alloc(1301)), /shape/);
  const missing = rosterPayload();
  missing.fill(0, 30, 40);
  assert.throws(() => decodePatch1620RosterPayload(missing), /9 champion rows/);
  const extra = rosterPayload();
  Buffer.from(STRINGS[0][1], 'hex').copy(extra, 10);
  assert.throws(() => decodePatch1620RosterPayload(extra), /11 champion rows/);
});

test('16.20 turret counts credit the opposing team', () => {
  assert.deepEqual(decodePatch1620TurretSnapshot(turrets([0x88, 0x8b, 0x92])), { 100: 1, 200: 2 });
  assert.equal(decodePatch1620TurretSnapshot([]), null);
  assert.throws(() => decodePatch1620TurretSnapshot(turrets().slice(1)), /expected 22/);
  const duplicate = turrets();
  duplicate[1] = duplicate[0];
  assert.throws(() => decodePatch1620TurretSnapshot(duplicate), /duplicate/);
});

test('16.20 turret decoder rejects corrupt selectors, padding, lengths and state disagreement', () => {
  for (const mutate of [
    (b) => b.payload.fill(0), (b) => b.payload.fill(255),
    (b) => { b.payload[0] ^= 0x40; }, (b) => { b.payload[1] ^= 0x08; },
    (b) => { b.payload[2] |= 0xf0; }, (b) => { b.payload[0] ^= 1; },
    (b) => { b.payload[0] ^= 2; }, (b) => { b.payload[0] ^= 4; },
    (b) => { b.length--; },
    (b) => { b.payload = Buffer.alloc(46); b.length = 46; },
    (b) => { b.payload = Buffer.alloc(64); b.length = 64; }
  ]) {
    const blocks = turrets(); mutate(blocks[0]);
    assert.throws(() => decodePatch1620TurretSnapshot(blocks));
  }
});

test('production registration decodes the complete 16.20 grammar and fails closed across versions/modes', () => {
  const payload = rosterPayload();
  const blocks = [{ packetId: 522, param: 0, length: payload.length, payload, timestamp: 600 },
    ...turrets(), ...Array.from({ length: 10 }, (_, slot) => {
      const vector = Buffer.alloc(1260); vector.writeUInt32LE(slot < 5 ? 100 : 200, 0x20);
      const payload = heroPayload(vector);
      return { packetId: 444, param: 0x400000ae + slot, length: payload.length, payload, timestamp: 600 };
    })];
  for (let slot = 0; slot < 10; slot++) for (let family = 0; family < 10; family++) {
    blocks.push({ packetId: 2000 + family, param: 0x400000ae + slot,
      payload: Buffer.alloc(1), length: 1, timestamp: 600 });
  }
  const decoder = new KeyframeSnapshotDecoder();
  for (const queueId of [400, 420, 440, 2400]) {
    const result = decoder.decode({ blocks, queueId, clientVersion: '16.20.824.8524' });
    assert.match(result.profileId, /^league-16\.20-/);
    assert.equal(result.participants[0].championId, 68);
    assert.equal(result.capabilities.items, 'unavailable');
    const malformedInventory = { packetId: 227, param: 0x400000ae,
      length: 99, payload: Buffer.alloc(1), timestamp: 600 };
    assert.deepEqual(decoder.decode({ blocks: [...blocks, malformedInventory],
      queueId, clientVersion: '16.20.824.8524' }).participants, result.participants);
  }
  for (const version of ['16.19.821.7343', '16.21.1', '116.20.1']) {
    assert.throws(() => decoder.decode({ blocks, queueId: 420, clientVersion: version }));
  }
  assert.throws(() => decoder.decode({ blocks, queueId: 450, clientVersion: '16.20.821.7343' }));
  const bad = blocks.map((b) => b.packetId === 444 ? { ...b, payload: Buffer.alloc(b.length) } : b);
  assert.throws(() => decoder.decode({ blocks: bad, queueId: 440, clientVersion: '16.20.821.7343' }));
});
