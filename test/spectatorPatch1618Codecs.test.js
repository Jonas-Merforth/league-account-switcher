import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodePatch1618HeroStats,
  decodePatch1618RosterPayload,
  decodePatch1618TurretSnapshot,
  PATCH_16_18_CHAMPION_IDS
} from '../src/core/spectator/patch-16-18-codecs.js';

const MUTATION_TABLE = Buffer.from(
  'd75682dc83028f2935042171799e927fcb976a5105c76fe640637e345b4707785a'
  + '96b8b92c995e6ed1754161245f4aaa4bcf0ed4865dba1d3f2bdf62f0330055ca'
  + 'fc19acf3662369bceb46f89c50874d6d108e88be1bb5da4e1a13cc2209ada49d'
  + '30a6e57dfac91712c2fde1bbe70b98bfbd1137c07cf795b6dd49f4812a9f1cfb'
  + '8d9a727b577a43b3a953e459202fa8f67436a085f1a7147031840cb2a5dbe816'
  + 'ae3d25b1cd9b0367155cea1f39a1440a8b76de606593f264d5c1c84c064fb7ed'
  + 'fee0f9a2184891ce1e3cb46c425494e328e90127ec0d45ff26efe28aabd9f508c'
  + '4af32c56b80c6c358eea33e2d0f893ab0d2d33873d8d08c7790523bd62e68',
  'hex'
);

const TEAM_100_TURRETS = [0x88, 0x8b, 0x8c, 0x8d, 0x8e, 0x94, 0x9a, 0xa2, 0xa3, 0xa6, 0xab];
const TEAM_200_TURRETS = [0x92, 0x93, 0x96, 0x97, 0x98, 0x9b, 0xa0, 0xa1, 0xa4, 0xa5, 0xa7];

function turretPayload(length = 48) {
  const payload = Buffer.alloc(length);
  payload[0] = 0xfc;
  payload[1] = 0x12;
  payload[2] = 0xf4;
  return payload;
}

function rotateRight8(value, bits) {
  const count = bits & 7;
  return ((value >>> count) | (value << (8 - count))) & 0xff;
}

function rotateLeft8(value, bits) {
  return rotateRight8(value, 8 - (bits & 7));
}

function swapAdjacentBits(value) {
  return (((value & 0xd5) << 1) | ((value >>> 1) & 0x55)) & 0xff;
}

function inverse(transform) {
  const result = new Map();
  for (let value = 0; value < 256; value += 1) result.set(transform(value), value);
  assert.equal(result.size, 256);
  return result;
}

function heroByte(value) {
  let decoded = rotateRight8(value, 2);
  decoded = (decoded - 0x48) & 0xff;
  decoded = swapAdjacentBits(decoded);
  decoded = rotateRight8(decoded, 4);
  return swapAdjacentBits(decoded);
}

function encodeHeroVector(vector) {
  const encode = inverse(heroByte);
  const wire = [0xcb, encode.get(0xf0), encode.get(0x09)];
  for (let index = vector.length - 1; index >= 0; index -= 1) {
    wire.push(encode.get(vector[index]));
  }
  return Buffer.from(wire);
}

function rosterReaderA(value) {
  return MUTATION_TABLE[(MUTATION_TABLE[(0x26 - value) & 0xff] - 0x28) & 0xff];
}

function rosterReaderB(value) {
  let decoded = (value - 0x66) & 0xff;
  decoded = rotateLeft8(decoded, 5);
  decoded = MUTATION_TABLE[decoded];
  decoded = (decoded + 0x12) & 0xff;
  decoded = swapAdjacentBits(decoded);
  decoded = (decoded + 0x6e) & 0xff;
  return (~decoded) & 0xff;
}

function rosterReaderC(value) {
  let decoded = rotateRight8(value, 3);
  decoded = swapAdjacentBits(decoded);
  decoded = rotateLeft8(decoded, 3);
  decoded ^= 0x25;
  decoded = MUTATION_TABLE[decoded];
  return rotateRight8(decoded, 1);
}

function encodeRosterString(value, transform) {
  const encode = inverse(transform);
  const bytes = Buffer.from(value, 'utf8');
  const wire = [encode.get(bytes.length)];
  for (const byte of bytes) wire.push(encode.get(byte));
  return Buffer.from(wire);
}

test('decodes absolute 16.18 hero scoreboard and objective fields', () => {
  const vector = Buffer.alloc(1_264);
  vector.writeUInt32LE(200, 0x20);
  vector.writeFloatLE(13_020, 0x28);
  vector.writeFloatLE(121, 0x3c);
  vector.writeFloatLE(19, 0x40);
  vector.writeUInt32LE(9, 0x4c);
  vector.writeUInt32LE(4, 0x50);
  vector.writeUInt32LE(11, 0x54);
  vector.writeUInt32LE(1, 0x78);
  vector.writeUInt32LE(2, 0x7c);
  vector.writeUInt32LE(3, 0x80);
  vector.writeUInt32LE(4, 0x84);
  vector.writeUInt32LE(1, 0xa4);
  vector.writeUInt32LE(2, 0xa8);
  vector.writeUInt32LE(1, 0xac);
  vector.writeUInt32LE(1, 0xb0);
  vector.writeUInt32LE(3, 0xb4);
  vector.writeUInt32LE(1, 0xb8);

  assert.deepEqual(decodePatch1618HeroStats(encodeHeroVector(vector)), {
    teamId: 200,
    experience: 13_020,
    level: 15,
    score: { kills: 9, deaths: 4, assists: 11, cs: 140 },
    credits: {
      inhibitorsKilled: 1,
      inhibitorTakedowns: 2,
      turretsKilled: 3,
      turretTakedowns: 4,
      barons: 1,
      dragons: 2,
      elderDragons: 1,
      riftHeralds: 1,
      voidGrubs: 3,
      atakhan: 1
    }
  });
});

test('reverses the backwards-written 16.18 participant roster into slot order', () => {
  const payloadOrder = [
    'Zaahen', 'Yunara', 'Vladimir', 'Viego', 'Tryndamere',
    'Rell', 'Kaisa', 'Neeko', 'Nocturne', 'KSante'
  ];
  const variants = [rosterReaderA, rosterReaderB, rosterReaderC];
  const payload = Buffer.alloc(1_050);
  payloadOrder.forEach((champion, index) => {
    encodeRosterString(champion, variants[index % variants.length])
      .copy(payload, 30 + index * 100);
  });
  const roster = decodePatch1618RosterPayload(payload);
  assert.deepEqual(
    roster.map(({ participantSlot, championName }) => [participantSlot, championName]),
    [...payloadOrder].reverse().map((champion, index) => [index + 1, champion])
  );
  assert.equal(roster[0].championId, PATCH_16_18_CHAMPION_IDS.KSante);
  assert.equal(roster[9].championId, PATCH_16_18_CHAMPION_IDS.Zaahen);
});

test('decodes 16.18 tower totals from the agreed destroyed bits', () => {
  const destroyed = new Set([0x8b, 0x94, 0x9a, 0x92, 0xa0]);
  const blocks = [...TEAM_100_TURRETS, ...TEAM_200_TURRETS].map((lowId) => {
    const payload = turretPayload();
    if (destroyed.has(lowId)) {
      payload[1] |= 1 << 5;
      payload[2] |= 1 << 3;
    }
    return { packetId: 1110, param: 0x40000000 + lowId, length: 48, payload };
  });
  assert.deepEqual(decodePatch1618TurretSnapshot(blocks), { 100: 2, 200: 3 });
});

test('fails closed on old or malformed 16.18 packet shapes', () => {
  assert.throws(() => decodePatch1618HeroStats(Buffer.alloc(1_264)), /shape/);
  assert.throws(() => decodePatch1618RosterPayload(Buffer.alloc(799)), /shape/);
  assert.throws(() => decodePatch1618RosterPayload(Buffer.alloc(1_050)), /expected ten/);
  assert.throws(() => decodePatch1618TurretSnapshot([{
    packetId: 1110,
    param: 0x40000088,
    length: 48,
    payload: Buffer.alloc(48)
  }]), /expected 22/);
  assert.throws(() => decodePatch1618TurretSnapshot(
    [...TEAM_100_TURRETS, ...TEAM_200_TURRETS].map((lowId) => {
      const payload = turretPayload(47);
      if (lowId === 0x8b) payload[1] |= 1 << 5;
      return {
        packetId: 1110,
        param: 0x40000000 + lowId,
        length: 47,
        payload
      };
    })
  ), /disagree/);
});

test('rejects malformed turret headers even when both state bits agree', () => {
  for (const corrupt of [
    (payload) => payload.fill(0),
    (payload) => payload.fill(0xff),
    (payload) => { payload[0] ^= 1; },
    (payload) => { payload[2] &= 0x0f; }
  ]) {
    const blocks = [...TEAM_100_TURRETS, ...TEAM_200_TURRETS].map((lowId) => {
      const payload = turretPayload();
      if (lowId === 0x88) corrupt(payload);
      return { packetId: 1110, param: 0x40000000 + lowId, length: payload.length, payload };
    });
    assert.throws(() => decodePatch1618TurretSnapshot(blocks), /shape/);
  }
});

test('allows variable turret header selectors and both verified length boundaries', () => {
  const blocks = [...TEAM_100_TURRETS, ...TEAM_200_TURRETS].map((lowId, index) => {
    const payload = turretPayload(index % 2 ? 47 : 63);
    Buffer.from(index % 2 ? 'bc49f4' : '2c66f9', 'hex').copy(payload);
    return { packetId: 1110, param: 0x40000000 + lowId, length: payload.length, payload };
  });
  assert.deepEqual(decodePatch1618TurretSnapshot(blocks), { 100: 5, 200: 6 });
});
