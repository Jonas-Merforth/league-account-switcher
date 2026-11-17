import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeDamageHeroSpawn, decodeDamageStatEvent, decodeDeathRecap,
  decodeDeathRecapDuration } from '../src/core/damagePacketFields16_22.js';

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

// Hero stat snapshots (type 664). The payload below hashes to a synthetic
// fixture whose fields were checked with the pinned client deserializer.
const heroStatsTable = Buffer.from('030bf2fae2ead2da434b333b232b131b828a727a626a525ac2cab2baa2aa929a020af1f9e1e9d1d9424a323a222a121a8189717961695159c1c9b1b9a1a99199050df4fce4ecd4dc454d353d252d151d848c747c646c545cc4ccb4bca4ac949c040cf3fbe3ebd3db444c343c242c141c838b737b636b535bc3cbb3bba3ab939b070ff6fee6eed6de474f373f272f171f868e767e666e565ec6ceb6bea6ae969e060ef5fde5edd5dd464e363e262e161e858d757d656d555dc5cdb5bda5ad959d0109f0f8e0e8d0d841493139212911198088707860685058c0c8b0b8a0a890980008f7ffe7efd7df4048303820281018878f777f676f575fc7cfb7bfa7af979f', 'hex');
const encodeHeroStatsByte = Buffer.alloc(256);
heroStatsTable.forEach((decoded, encoded) => { encodeHeroStatsByte[decoded] = encoded; });

function heroStatsPayload({ team = 100, kda = [7, 3, 11], dealt = [81234.5, 50000.25, 30000.25, 1234],
  champions = [23456.75, 12000.5, 10000.25, 1456], taken = [19876.5, 9000, 8000.5, 2876], flags = 0xe1 } = {}) {
  const vector = Buffer.alloc(1260);
  vector.writeUInt32LE(team, 0x20);
  kda.forEach((value, index) => vector.writeUInt32LE(value, 0x4c + index * 4));
  for (const [offset, values] of [[0x1d0, dealt], [0x1e0, champions], [0x1f0, taken]]) {
    values.forEach((value, index) => vector.writeFloatLE(value, offset + index * 4));
  }
  const encoded = Buffer.alloc(vector.length);
  for (let i = 0; i < vector.length; i++) {
    encoded[i] = encodeHeroStatsByte[vector[i % 2 ? vector.length - 1 - (i >>> 1) : i >>> 1]];
  }
  return Buffer.concat([Buffer.from([flags, encodeHeroStatsByte[0xec], encodeHeroStatsByte[0x09]]), encoded]);
}

test('decodes the hero stat snapshot in its live and spectator forms', async () => {
  const { createHash } = await import('node:crypto');
  const { decodeHeroStatSnapshot, decodeLiveHeroStatSnapshot } = await import('../src/core/damagePacketFields16_22.js');
  const spectator = heroStatsPayload();
  const live = Buffer.concat([Buffer.of(0x3d), spectator]);
  assert.equal(createHash('sha256').update(live).digest('hex'), 'f7a32bbf5e23e7fbb4ec06c5114f379e1252de38a6023a0328d6312478df6d67');
  const expected = {
    team: 100, kills: 7, deaths: 3, assists: 11,
    damageDealt: { total: 81234.5, physical: 50000.25, magic: 30000.25, true: 1234 },
    damageToChampions: { total: 23456.75, physical: 12000.5, magic: 10000.25, true: 1456 },
    damageTaken: { total: 19876.5, physical: 9000, magic: 8000.5, true: 2876 }
  };
  assert.deepEqual(decodeHeroStatSnapshot(spectator), expected);
  assert.deepEqual(decodeLiveHeroStatSnapshot(live), { id: 0x40000048, ...expected });
});

test('rejects hero stat snapshots that do not match the 16.22 layout', async () => {
  const { decodeHeroStatSnapshot } = await import('../src/core/damagePacketFields16_22.js');
  assert.equal(decodeHeroStatSnapshot(heroStatsPayload({ team: 300 })), null);
  assert.equal(decodeHeroStatSnapshot(heroStatsPayload({ flags: 0x08 })), null);
  assert.throws(() => decodeHeroStatSnapshot(heroStatsPayload().subarray(0, -1)), RangeError);
  assert.throws(() => decodeHeroStatSnapshot(Buffer.concat([heroStatsPayload(), Buffer.of(0)])), RangeError);
  assert.throws(() => decodeHeroStatSnapshot(heroStatsPayload({ champions: [Number.NaN, 0, 0, 0] })), RangeError);
});

// Synthetic type 393 packets in the playing-client form (owner first). Every
// decoded field below was checked against the pinned client deserializer and
// consumer. The first reads every optional field: amount, hash, source,
// target, type, display, the unreported ID and four-byte value, and result.
const fullDisplay = Buffer.from('7bfa08020c00b24385851e8afe27c16539e342098cd07411223344a5', 'hex');
// Selectors that store defaults for every field, so only the owner and the
// four selector bytes are on the wire.
const defaultDisplay = Buffer.from('7bfa43608208', 'hex');

test('decodes every type 393 field the combat text consumer reads', async () => {
  const { decodeDamageDisplay } = await import('../src/core/damagePacketFields16_22.js');
  assert.deepEqual(decodeDamageDisplay(fullDisplay), {
    sourceId: 0x400000a1, targetId: 0x400000b2, amount: 123.5,
    typeCode: 2, resultCode: 5, displayCode: 3, hash: 0x12345678
  });
});

test('uses the client defaults for type 393 fields without wire data', async () => {
  const { decodeDamageDisplay } = await import('../src/core/damagePacketFields16_22.js');
  const expected = { sourceId: 0, targetId: 0, amount: 1, typeCode: 1, resultCode: 0, displayCode: 1, hash: 2 };
  assert.deepEqual(decodeDamageDisplay(defaultDisplay), expected);
  // Amount selectors 4 and 7 store 2 and 0. Selector 2 stores -1, which the
  // client oracle rejects as an invalid amount.
  assert.deepEqual(decodeDamageDisplay(Buffer.from('7bfa43408208', 'hex')), { ...expected, amount: 2 });
  assert.deepEqual(decodeDamageDisplay(Buffer.from('7bfa43708208', 'hex')), { ...expected, amount: 0 });
  assert.throws(() => decodeDamageDisplay(Buffer.from('7bfa43208208', 'hex')), RangeError);
  // A six-digit source varint: the client ORs the last digit in at shift
  // 35, which wraps to 3, giving 0x29 before the ID flip.
  assert.deepEqual(decodeDamageDisplay(Buffer.from('7bfa4360800865c1c1c1c139', 'hex')),
    { ...expected, sourceId: 0x40000029 });
});

test('rejects truncated and trailing type 393 packets', async () => {
  const { decodeDamageDisplay } = await import('../src/core/damagePacketFields16_22.js');
  for (const packet of [fullDisplay, defaultDisplay]) {
    assert.throws(() => decodeDamageDisplay(packet.subarray(0, -1)), RangeError);
    assert.throws(() => decodeDamageDisplay(Buffer.concat([packet, Buffer.of(0)])), RangeError);
  }
  assert.throws(() => decodeDamageDisplay(Buffer.alloc(0)), RangeError);
});
