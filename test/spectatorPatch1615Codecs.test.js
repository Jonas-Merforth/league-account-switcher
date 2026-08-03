import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodePatch1615HeroStats,
  decodePatch1615RosterPayload,
  decodePatch1615TurretSnapshot,
  PATCH_16_15_CHAMPION_IDS
} from '../src/core/spectator/patch-16-15-codecs.js';

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
  return rotateRight8(MUTATION_TABLE[swapAdjacentBits(value) ^ 0x4d], 1);
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
    0xaf,
    encode.get(0xc4),
    encode.get(0x0b),
    ...wire
  ]);
}

function rosterReverseB(value) {
  let decoded = value ^ 0x97;
  decoded = rotateRight8(decoded, 4);
  decoded = MUTATION_TABLE[decoded];
  return decoded ^ 0x12;
}

function rosterReverseC(value) {
  let decoded = (value + 0x33) & 0xff;
  decoded = swapAdjacentBits(decoded);
  decoded ^= 0x6e;
  decoded = swapAdjacentBits(decoded);
  return decoded ^ 0x79;
}

function rosterAlternatingF(value) {
  let decoded = (value - 0x52) & 0xff;
  decoded = MUTATION_TABLE[decoded];
  decoded = (decoded + 0x21) & 0xff;
  decoded = swapAdjacentBits(decoded);
  decoded = MUTATION_TABLE[decoded];
  decoded = (~decoded) & 0xff;
  decoded = MUTATION_TABLE[decoded];
  return rotateRight8(decoded, 5);
}

function encodeRosterString(value, transform, order) {
  const encode = inverse(transform);
  const bytes = Buffer.from(value, 'utf8');
  const wire = [encode.get(bytes.length)];
  if (order === 'reverse') {
    for (let index = bytes.length - 1; index >= 0; index -= 1) {
      wire.push(encode.get(bytes[index]));
    }
  } else {
    let front = 0;
    let back = bytes.length - 1;
    while (front < back) {
      wire.push(encode.get(bytes[front]), encode.get(bytes[back]));
      front += 1;
      back -= 1;
    }
    if (front === back) wire.push(encode.get(bytes[front]));
  }
  return Buffer.from(wire);
}

test('decodes absolute 16.15 hero scoreboard and objective fields', () => {
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

  assert.deepEqual(decodePatch1615HeroStats(encodeHeroVector(vector)), {
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

test('recovers the sequential 16.15 participant roster across all live variants', () => {
  const champions = [
    'Shen', 'LeeSin', 'Vex', 'Samira', 'Pyke',
    'Garen', 'Zac', 'Sylas', 'MissFortune', 'Braum'
  ];
  const variants = [
    [rosterReverseB, 'reverse'],
    [rosterReverseC, 'reverse'],
    [rosterAlternatingF, 'alternating']
  ];
  const payload = Buffer.alloc(1_067);
  champions.forEach((champion, index) => {
    const [transform, order] = variants[index % variants.length];
    encodeRosterString(champion, transform, order).copy(payload, 40 + index * 100);
  });

  const roster = decodePatch1615RosterPayload(payload);
  assert.deepEqual(
    roster.map(({ participantSlot, championName }) => [participantSlot, championName]),
    champions.map((champion, index) => [index + 1, champion])
  );
  assert.equal(roster[2].championId, PATCH_16_15_CHAMPION_IDS.Vex);
});

test('decodes 16.15 tower totals from the new alive bit', () => {
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
    payload[2] = 0x55;
    if ([0x8b, 0x94, 0x9a, 0x92, 0xa0].includes(lowId)) payload[2] = 0x54;
    return {
      packetId: 298,
      param: 0x40000000 + lowId,
      length: payload.length,
      payload
    };
  });

  assert.deepEqual(decodePatch1615TurretSnapshot(blocks), {
    100: 2,
    200: 3
  });
});

test('fails closed on malformed 16.15 packet shapes', () => {
  assert.throws(() => decodePatch1615HeroStats(Buffer.alloc(1_479)), /shape/);
  assert.throws(() => decodePatch1615RosterPayload(Buffer.alloc(799)), /shape/);
  assert.throws(() => decodePatch1615RosterPayload(Buffer.alloc(899)), /expected ten/);
  assert.throws(() => decodePatch1615RosterPayload(Buffer.alloc(1_067)), /expected ten/);
  assert.throws(() => decodePatch1615TurretSnapshot([{
    packetId: 298,
    param: 0x40000088,
    length: 47,
    payload: Buffer.alloc(47)
  }]), /expected 22/);
});
