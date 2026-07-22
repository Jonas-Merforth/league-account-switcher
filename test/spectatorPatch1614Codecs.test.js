import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodePatch1614HeroStats,
  decodePatch1614InventoryPayload,
  decodePatch1614ReplicationRecords,
  decodePatch1614RosterPayload,
  decodePatch1614TurretSnapshot,
  levelFromExperience,
  PATCH_16_14_CHAMPION_IDS,
  SUMMONERS_RIFT_TOP_EXPERIENCE_THRESHOLDS
} from '../src/core/spectator/patch-16-14-codecs.js';

const HERO_TABLE = Buffer.from(
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

function heroByte(value) {
  let result = rotateRight8(value, 4);
  result = (result - 0x75) & 0xff;
  result = swapAdjacentBits(result);
  result = rotateRight8(result, 1) ^ 0xf5;
  return HERO_TABLE[result];
}

function inverse(transform) {
  const result = new Map();
  for (let value = 0; value < 256; value += 1) result.set(transform(value), value);
  assert.equal(result.size, 256);
  return result;
}

function replicationByte(value) {
  let result = ((value << 1) | (value >>> 7)) & 0xff;
  result ^= 0x11;
  result = HERO_TABLE[result];
  result = HERO_TABLE[result];
  result = rotateRight8(result, 1);
  result = (~result) & 0xff;
  result = HERO_TABLE[result];
  return rotateRight8(result, 5);
}

function inventoryCountByte(value) {
  let result = value ^ 0x51;
  result = swapAdjacentBits(result);
  result = (~result) & 0xff;
  result = (result - 0x34) & 0xff;
  result = HERO_TABLE[result];
  result = swapAdjacentBits(result);
  return result ^ 0xb7;
}

function inventoryItemIdByte(value) {
  let result = rotateRight8(value, 5) ^ 0x75;
  result = swapAdjacentBits(result);
  result = (result + 0x19) & 0xff;
  return rotateRight8(result, 3);
}

function inventorySlotByte(value) {
  let result = HERO_TABLE[value];
  result = rotateRight8(result, 5) ^ 0x9e;
  result = rotateRight8(result, 4);
  result = (result + 0x14) & 0xff;
  return result ^ 0x65;
}

function encodeVarint(value, encodeByte) {
  const output = [];
  let remaining = value >>> 0;
  do {
    let current = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining) current |= 0x80;
    output.push(encodeByte.get(current));
  } while (remaining);
  return output;
}

function encodeReplicationVector(vector) {
  const encodeByte = inverse(replicationByte);
  const prefix = Buffer.alloc(9, 0x5a);
  return Buffer.from([
    ...prefix,
    ...encodeVarint(vector.length, encodeByte),
    ...vector.map((byte) => encodeByte.get(byte)),
    0xed
  ]);
}

function encodeHeroVector(vector) {
  const inverseHero = inverse(heroByte);
  const encodedLength = [0xc4, 0x0b].map((value) => inverseHero.get(value));
  const wire = [];
  let front = 0;
  let back = vector.length - 1;
  while (front < back) {
    wire.push(inverseHero.get(vector[front]), inverseHero.get(vector[back]));
    front += 1;
    back -= 1;
  }
  if (front === back) wire.push(inverseHero.get(vector[front]));
  return Buffer.from([0xe8, ...encodedLength, ...wire]);
}

function generatedHeader(bytes, fields) {
  let value = 0;
  for (const [offset, field] of fields) value |= field << offset;
  const output = Buffer.alloc(bytes);
  output.writeUIntLE(value >>> 0, 0, bytes);
  return output;
}

function encodeInventoryPayload(itemIds) {
  assert.equal(itemIds.length, 10);
  const encodeCount = inverse(inventoryCountByte);
  const encodeItem = inverse(inventoryItemIdByte);
  const encodeSlot = inverse(inventorySlotByte);
  const records = [];

  for (let slot = 9; slot >= 0; slot -= 1) {
    const itemId = itemIds[slot];
    const defaultState = itemId === 0;
    records.push(generatedHeader(4, [
      [12, 6],
      [15, 3],
      [18, 0],
      [9, 3],
      [6, 3],
      [3, 0],
      [0, 3],
      [21, 4],
      [24, defaultState ? 1 : 0]
    ]));
    if (defaultState) continue;

    const slotField = slot === 0 ? 0 : slot === 1 ? 3 : slot === 2 ? 1 : 2;
    records.push(generatedHeader(3, [
      [4, 0],
      [20, slotField],
      [18, 1],
      [3, 0],
      [9, 0],
      [7, 1],
      [10, 3],
      [15, 5],
      [19, 1],
      [0, 5],
      [13, 2]
    ]));
    records.push(Buffer.from(encodeVarint(itemId, encodeItem)));
    if (slot >= 3) records.push(Buffer.from([encodeSlot.get(slot)]));
  }

  return Buffer.concat([
    Buffer.from([0x00, 0x07]),
    Buffer.from(encodeVarint(10, encodeCount)),
    ...records
  ]);
}

test('decodes absolute KDA, CS, team, structures, and objective credits from packet 747', () => {
  const vector = Buffer.alloc(1476);
  vector.writeUInt32LE(200, 0x20);
  vector.writeFloatLE(16_480, 0x28);
  vector.writeFloatLE(143, 0x3c);
  vector.writeFloatLE(24, 0x40);
  vector.writeUInt32LE(12, 0x4c);
  vector.writeUInt32LE(3, 0x50);
  vector.writeUInt32LE(6, 0x54);
  vector.writeUInt32LE(1, 0x78);
  vector.writeUInt32LE(2, 0x7c);
  vector.writeUInt32LE(4, 0x80);
  vector.writeUInt32LE(7, 0x84);
  vector.writeUInt32LE(1, 0xa4);
  vector.writeUInt32LE(2, 0xa8);
  vector.writeUInt32LE(1, 0xac);
  vector.writeUInt32LE(1, 0xb0);
  vector.writeUInt32LE(3, 0xb4);
  vector.writeUInt32LE(1, 0xb8);

  assert.deepEqual(decodePatch1614HeroStats(encodeHeroVector(vector)), {
    teamId: 200,
    experience: 16_480,
    level: 17,
    score: { kills: 12, deaths: 3, assists: 6, cs: 167 },
    credits: {
      inhibitorsKilled: 1,
      inhibitorTakedowns: 2,
      turretsKilled: 4,
      turretTakedowns: 7,
      barons: 1,
      dragons: 2,
      elderDragons: 1,
      riftHeralds: 1,
      voidGrubs: 3,
      atakhan: 1
    }
  });
});

test('derives champion level from cumulative experience boundaries', () => {
  assert.equal(levelFromExperience(0), 1);
  assert.equal(levelFromExperience(279.999), 1);
  assert.equal(levelFromExperience(280), 2);
  assert.equal(levelFromExperience(16_479.999), 16);
  assert.equal(levelFromExperience(16_480), 17);
  assert.equal(levelFromExperience(18_360), 18);
  assert.equal(levelFromExperience(99_999), 18);
  assert.equal(
    levelFromExperience(20_339.999, SUMMONERS_RIFT_TOP_EXPERIENCE_THRESHOLDS),
    18
  );
  assert.equal(
    levelFromExperience(20_340, SUMMONERS_RIFT_TOP_EXPERIENCE_THRESHOLDS),
    19
  );
  assert.equal(
    levelFromExperience(22_420, SUMMONERS_RIFT_TOP_EXPERIENCE_THRESHOLDS),
    20
  );
  assert.throws(() => levelFromExperience(-1), /finite non-negative/);
});

test('decodes packet 107 and preserves its replication record grammar', () => {
  const record = Buffer.concat([
    Buffer.from([
      0x2c,
      0x9c, 0x00, 0x00, 0x40,
      0xff, 0xff, 0x03, 0x00,
      0xff
    ]),
    Buffer.alloc(255, 0xde),
    Buffer.from([0x03, 0x00, 0x00, 0x00, 0xff]),
    Buffer.alloc(255, 0xad),
    Buffer.from([0x0f, 0x00, 0x00, 0x00, 0xff]),
    Buffer.alloc(255, 0xbe)
  ]);
  const vector = Buffer.concat(Array.from({ length: 10 }, () => record));
  const records = decodePatch1614ReplicationRecords(
    encodeReplicationVector(vector)
  );

  assert.equal(records.length, 10);
  assert.deepEqual(records[0], {
    netId: 0x4000009c,
    primaryMask: 0x2c,
    groups: [
      {
        group: 2,
        secondaryMask: 0x0003ffff,
        data: Buffer.alloc(255, 0xde)
      },
      {
        group: 3,
        secondaryMask: 0x00000003,
        data: Buffer.alloc(255, 0xad)
      },
      {
        group: 5,
        secondaryMask: 0x0000000f,
        data: Buffer.alloc(255, 0xbe)
      }
    ]
  });
});

test('decodes all ten absolute packet 129 inventory slots', () => {
  const itemIds = [
    1056, 3047, 4633, 6653, 3116,
    1043, 3340, 2001, 1220, 0
  ];
  assert.deepEqual(
    decodePatch1614InventoryPayload(encodeInventoryPayload(itemIds)),
    itemIds.map((itemId, slot) => ({ slot, itemId }))
  );
});

test('decodes absolute team tower totals from all 22 turret snapshots', () => {
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
    payload[0] = 1 << 3;
    payload[2] = 0xd0;
    if ([0x8b, 0x94, 0x9a, 0x92, 0xa0].includes(lowId)) {
      payload[0] &= ~(1 << 3);
    }
    return {
      packetId: 815,
      param: 0x40000000 + lowId,
      length: payload.length,
      payload
    };
  });

  assert.deepEqual(decodePatch1614TurretSnapshot(blocks), {
    100: 2,
    200: 3
  });
});

function rosterForward(value) {
  let decoded = (value - 0x21) & 0xff;
  decoded = rotateRight8(decoded, 3);
  decoded = (decoded - 0x6a) & 0xff;
  decoded = rotateRight8(decoded, 4);
  decoded = (~decoded) & 0xff;
  return rotateRight8(decoded, 1);
}

function encodeForwardString(value) {
  const encode = inverse(rosterForward);
  return Buffer.from([
    encode.get(Buffer.byteLength(value)),
    ...Buffer.from(value, 'utf8').map((byte) => encode.get(byte))
  ]);
}

test('recovers exact packet 761 champion names and restores participant order', () => {
  const payload = Buffer.alloc(1136);
  const wireChampions = [
    'Mordekaiser', 'FiddleSticks', 'Zyra', 'Quinn', 'Sivir',
    'Seraphine', 'Malzahar', 'Bard', 'Graves', 'Aatrox'
  ];
  wireChampions.forEach((champion, index) => {
    encodeForwardString(champion).copy(payload, 20 + index * 100);
  });

  const roster = decodePatch1614RosterPayload(payload);
  assert.deepEqual(
    roster.map(({ participantSlot, championName }) => [participantSlot, championName]),
    [
      [1, 'Mordekaiser'],
      [2, 'FiddleSticks'],
      [3, 'Quinn'],
      [4, 'Seraphine'],
      [5, 'Bard'],
      [6, 'Aatrox'],
      [7, 'Graves'],
      [8, 'Malzahar'],
      [9, 'Sivir'],
      [10, 'Zyra']
    ]
  );
  assert.equal(roster[0].championId, PATCH_16_14_CHAMPION_IDS.Mordekaiser);
  assert.equal(roster[1].championId, PATCH_16_14_CHAMPION_IDS.FiddleSticks);
});

test('fails closed on malformed current-patch packet shapes', () => {
  assert.throws(() => decodePatch1614HeroStats(Buffer.alloc(1479)), /shape/);
  assert.throws(
    () => decodePatch1614ReplicationRecords(Buffer.alloc(5999)),
    /shape/
  );
  assert.throws(
    () => decodePatch1614ReplicationRecords(Buffer.alloc(6000)),
    /expected one/
  );
  assert.throws(
    () => decodePatch1614InventoryPayload(Buffer.alloc(63)),
    /shape/
  );
  assert.throws(
    () => decodePatch1614InventoryPayload(Buffer.alloc(100)),
    /vector header/
  );
  assert.throws(
    () => decodePatch1614TurretSnapshot([{
      packetId: 815,
      param: 0x40000088,
      length: 47,
      payload: Buffer.alloc(47)
    }]),
    /expected 22/
  );
  assert.throws(() => decodePatch1614RosterPayload(Buffer.alloc(899)), /shape/);
  assert.throws(() => decodePatch1614RosterPayload(Buffer.alloc(1136)), /expected ten/);
});
