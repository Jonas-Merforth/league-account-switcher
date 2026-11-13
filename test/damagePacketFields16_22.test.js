import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeDamageHeroSpawn, decodeDamageStatEvent } from '../src/core/damagePacketFields16_22.js';

// Synthetic type 743 body with distinct physical, magic, true and extra fields.
// Its decoded fields were also checked against the pinned client deserializer.
const outgoing = Buffer.from([
  'd9fa30bf3d3d3d3d3d3d3d3d3d3d3d3d850e96df3d3d3d3d3d3d3d3d3d3d3d3d',
  '3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3e3e3d3d3e3f3d3d',
  '424d3d3d46a63d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3e3d3d08',
  '3d3d3d3d738790bf3088'
].join(''), 'hex');

test('decodes the three schools and reverses the endpoints for received damage', () => {
  const expected = {
    candidateSourceNetId: 0x400000a1,
    candidateTargetNetId: 0x400000b2,
    candidateAmount: 54.75,
    schools: { physical: 42.5, magic: 8.25, true: 4 },
    extraAmount: 3,
    candidateHash: 0x12345678,
    statDirection: 'outgoing'
  };
  assert.deepEqual(decodeDamageStatEvent(outgoing), expected);
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
