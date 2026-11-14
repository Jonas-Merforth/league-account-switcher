import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeDamageHealthUpdates, decodeDamageHeroSpawn, decodeDamageStatEvent,
  decodeDeathRecap, decodeDeathRecapDuration } from '../src/core/damagePacketFields16_22.js';

// Synthetic type 743 body with distinct physical, magic, true and extra fields.
// Its decoded fields were also checked against the pinned client deserializer.
const outgoing = Buffer.from([
  'd9fa30bf3d3d3d3d3d3d3d3d3d3d3d3d850e96df3d3d3d3d3d3d3d3d3d3d3d3d',
  '3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3e3e3d3d3e3f3d3d',
  '424d3d3d46a63d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3e3d3d08',
  '3d3d3d3d738790bf3088'
].join(''), 'hex');

// The 96-byte body starts at byte 4, reversed and byte-encoded.
const rotateLeft = (value, count) => (value << count | value >>> (8 - count)) & 255;
const decodeBodyByte = (value) => rotateLeft((rotateLeft((value + 0x62) & 255, 2) + 0x82) & 255, 4);
const encodeBodyByte = new Map(Array.from({ length: 256 }, (_, value) => [decodeBodyByte(value), value]));
function withBodyWord(packet, offset, value) {
  const copy = Buffer.from(packet);
  const word = Buffer.alloc(4);
  word.writeUInt32LE(value);
  for (let i = 0; i < 4; i++) copy[4 + 95 - (offset + i)] = encodeBodyByte.get(word[i]);
  return copy;
}

test('decodes the three schools and reverses the endpoints for received damage', () => {
  const expected = {
    candidateSourceNetId: 0x400000a1,
    candidateTargetNetId: 0x400000b2,
    candidateAmount: 54.75,
    schools: { physical: 42.5, magic: 8.25, true: 4 },
    extraAmount: 3,
    candidateHash: 0x12345678,
    candidateScriptHash: 0,
    candidateMissileHash: 0,
    candidateSlot: 0,
    statDirection: 'outgoing'
  };
  assert.deepEqual(decodeDamageStatEvent(outgoing), expected);
  const named = withBodyWord(withBodyWord(withBodyWord(outgoing, 16, 0x0cfa1315), 48, 0x09252018), 84, 46);
  assert.deepEqual(decodeDamageStatEvent(named), { ...expected,
    candidateScriptHash: 0x0cfa1315, candidateMissileHash: 0x09252018, candidateSlot: 46 });
  const incoming = Buffer.from(outgoing);
  incoming[incoming.length - 1] = 0xbf;
  assert.deepEqual(decodeDamageStatEvent(incoming), { ...expected,
    candidateSourceNetId: expected.candidateTargetNetId,
    candidateTargetNetId: expected.candidateSourceNetId,
    statDirection: 'incoming'
  });
});

test('ignores other schemas and rejects truncated and trailing data', () => {
  const other = Buffer.from(outgoing);
  other[other.length - 6] = 0x8a;
  assert.equal(decodeDamageStatEvent(other), null);
  assert.throws(() => decodeDamageStatEvent(outgoing.subarray(0, -1)), RangeError);
  assert.throws(() => decodeDamageStatEvent(Buffer.concat([outgoing, Buffer.of(0)])), RangeError);
});

test('decodes hero IDs and models in the two observed wire orders', () => {
  // Synthetic IDs and cleared unrelated fields. The client reader accepts all three.
  const fixtures = [
    [0x400002d3, 'Caitlyn', 'a631f4458e2f8f00000000000000000000000000985945000000000000000000000000000000000000000000000000000000fb6da71bb82a39e1002d'],
    [0x400002d4, 'Heimerdinger', 'a63176279e2ffe00000000000000000000000000e659f3000000000000000000000000000000000000000000000000000000000000959e0d51e1e9199e0d7fe90dc900'],
    [0x400002d5, 'PracticeTool_TargetDummy', 'a6317646963cfe00000000000000000000000000d659c10000000000000000000000000000000000000000000000000000000000000000000000004d6e7f7f71c75e0d519ef1cb634ba5a5cb0d31e95e31f19e6b00']
  ];
  for (const [id, model, hex] of fixtures) {
    const data = Buffer.from(hex, 'hex');
    assert.deepEqual(decodeDamageHeroSpawn(data), { id, model });
    assert.throws(() => decodeDamageHeroSpawn(data.subarray(0, -1)), RangeError);
    assert.throws(() => decodeDamageHeroSpawn(Buffer.concat([data, Buffer.of(0)])), RangeError);
  }
});

test('decodes replicated HP and compact zero for tracked targets only', () => {
  const id = 0x400002d5;
  const targets = new Set([id]);
  const alive = Buffer.from('a62c0373a24f6dd8835c2047dca8ff202020', 'hex');
  const dead = Buffer.from('a62c03e4a2b96dff83202020dc20ff', 'hex');
  assert.deepEqual(decodeDamageHealthUpdates(alive, targets), [{ id, health: 251.67115783691406 }]);
  assert.deepEqual(decodeDamageHealthUpdates(dead, targets), [{ id, health: 0 }]);
  assert.deepEqual(decodeDamageHealthUpdates(alive, new Set()), []);
  assert.throws(() => decodeDamageHealthUpdates(dead.subarray(0, -1), targets), RangeError);
});

test('reads server fight time after a synthetic recap damage row and detail', () => {
  const data = Buffer.from('a6986c00ee125b609b002e2ebb1e', 'hex');
  assert.equal(decodeDeathRecapDuration(data), 17.25);
  assert.equal(decodeDeathRecapDuration(Buffer.from('a6986a00', 'hex')), 0);
  assert.equal(decodeDeathRecapDuration(Buffer.from('a6986600', 'hex')), null);
  assert.equal(decodeDeathRecapDuration(Buffer.from('a6987200', 'hex')), 2);
  assert.throws(() => decodeDeathRecapDuration(data.subarray(0, -1)), RangeError);
  assert.throws(() => decodeDeathRecapDuration(Buffer.concat([data, Buffer.of(0)])), RangeError);
});

test('decodes outgoing recap schools separately from incoming damage and rounds each display row', () => {
  // Synthetic incoming row plus two outgoing rows, checked with the 16.22 client reader.
  const data = Buffer.from('a6984c00ee125b609b002e2ebb1e125f08800025d0a6a65d5d5df0b83fd8d808800096b0a6a65d5daf9bb838d8d8', 'hex');
  assert.deepEqual(decodeDeathRecap(data), {
    duration: 17.25,
    schools: { physical: 12.5, magic: 11.75, true: 2.375 },
    displayTypes: { physical: 14, magic: 12, true: 4 }
  });
  assert.throws(() => decodeDeathRecap(data.subarray(0, -1)), RangeError);

  const negativeDamage = Buffer.from('a6984e002e2ebb1e125bc880005d5d5df0b83fd8d8', 'hex');
  assert.deepEqual(decodeDeathRecap(negativeDamage), { duration: 17.25, schools: null, displayTypes: null });
});
