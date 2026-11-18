import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodePatch1616HeroStats,
  decodePatch1616RosterPayload,
  decodePatch1616TurretSnapshot,
  PATCH_16_16_CHAMPION_IDS
} from '../src/core/spectator/patch-16-16-codecs.js';

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

function rotateRight8(value, bits) {
  return ((value >>> bits) | (value << (8 - bits))) & 0xff;
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
  let decoded = (value - 0x12) & 0xff;
  decoded = swapAdjacentBits(decoded);
  decoded = MUTATION_TABLE[decoded];
  decoded = rotateRight8(decoded, 3);
  decoded = MUTATION_TABLE[decoded];
  decoded = (decoded - 0x5f) & 0xff;
  return MUTATION_TABLE[decoded];
}

function encodeHeroVector(vector) {
  const encode = inverse(heroByte);
  const wire = [];
  let front = 0;
  let back = vector.length - 1;
  while (front < back) {
    wire.push(encode.get(vector[front]), encode.get(vector[back]));
    front += 1;
    back -= 1;
  }
  return Buffer.from([
    0x0d,
    encode.get(0xc4),
    encode.get(0x0b),
    ...wire
  ]);
}

function rosterAlternatingA(value) {
  let decoded = swapAdjacentBits(value);
  decoded = rotateRight8(decoded, 6);
  decoded = swapAdjacentBits(decoded);
  decoded = MUTATION_TABLE[decoded];
  decoded = rotateRight8(decoded, 2);
  decoded = (decoded + 0x63) & 0xff;
  decoded = MUTATION_TABLE[decoded];
  return (decoded - 0x07) & 0xff;
}

function rosterAlternatingB(value) {
  return (rotateRight8((value + 0x1f) & 0xff, 4) - 0x68) & 0xff;
}

function rosterAlternatingC(value) {
  let decoded = rotateRight8(value, 6);
  decoded ^= 0x1a;
  decoded = rotateRight8(decoded, 5);
  decoded = (decoded - 0x68) & 0xff;
  return decoded ^ 0xe3;
}

function encodeRosterString(value, transform) {
  const encode = inverse(transform);
  const bytes = Buffer.from(value, 'utf8');
  const wire = [encode.get(bytes.length)];
  let front = 0;
  let back = bytes.length - 1;
  while (front < back) {
    wire.push(encode.get(bytes[front]), encode.get(bytes[back]));
    front += 1;
    back -= 1;
  }
  if (front === back) wire.push(encode.get(bytes[front]));
  return Buffer.from(wire);
}

test('decodes absolute 16.16 hero scoreboard and objective fields', () => {
  const vector = Buffer.alloc(1_476);
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

  assert.deepEqual(decodePatch1616HeroStats(encodeHeroVector(vector)), {
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

test('recovers the sequential 16.16 participant roster across all live variants', () => {
  const champions = [
    'KSante', 'Nocturne', 'Neeko', 'Kaisa', 'Rell',
    'Tryndamere', 'Viego', 'Vladimir', 'Yunara', 'Braum'
  ];
  const variants = [rosterAlternatingA, rosterAlternatingB, rosterAlternatingC];
  const payload = Buffer.alloc(1_050);
  champions.forEach((champion, index) => {
    encodeRosterString(champion, variants[index % variants.length])
      .copy(payload, 30 + index * 100);
  });

  const roster = decodePatch1616RosterPayload(payload);
  assert.deepEqual(
    roster.map(({ participantSlot, championName }) => [participantSlot, championName]),
    champions.map((champion, index) => [index + 1, champion])
  );
  assert.equal(roster[2].championId, PATCH_16_16_CHAMPION_IDS.Neeko);
});

test('decodes 16.16 tower totals from the retained alive bit', () => {
  const team100Turrets = new Set([
    0x88, 0x8b, 0x8c, 0x8d, 0x8e, 0x94,
    0x9a, 0xa2, 0xa3, 0xa6, 0xab
  ]);
  const team200Turrets = new Set([
    0x92, 0x93, 0x96, 0x97, 0x98, 0x9b,
    0xa0, 0xa1, 0xa4, 0xa5, 0xa7
  ]);
  const blocks = [...team100Turrets, ...team200Turrets].map((lowId) => {
    const payload = Buffer.alloc(47);
    payload[1] = 0x80;
    payload[2] = 0x41;
    if ([0x8b, 0x94, 0x9a, 0x92, 0xa0].includes(lowId)) payload[2] = 0x40;
    return {
      packetId: 320,
      param: 0x40000000 + lowId,
      length: payload.length,
      payload
    };
  });

  assert.deepEqual(decodePatch1616TurretSnapshot(blocks), {
    100: 2,
    200: 3
  });
});

test('fails closed on old or malformed 16.16 packet shapes', () => {
  assert.throws(() => decodePatch1616HeroStats(Buffer.alloc(1_479)), /shape/);
  assert.throws(() => decodePatch1616RosterPayload(Buffer.alloc(799)), /shape/);
  assert.throws(() => decodePatch1616RosterPayload(Buffer.alloc(1_050)), /expected ten/);
  assert.throws(() => decodePatch1616TurretSnapshot([{
    packetId: 320,
    param: 0x40000088,
    length: 47,
    payload: Buffer.alloc(47)
  }]), /expected 22/);
});
