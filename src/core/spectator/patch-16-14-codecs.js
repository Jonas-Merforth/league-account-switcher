const HERO_VECTOR_LENGTH = 1476;
const HERO_PAYLOAD_LENGTH = 1479;
const ROSTER_PAYLOAD_MIN_LENGTH = 900;
const ROSTER_PAYLOAD_MAX_LENGTH = 1300;
const REPLICATION_PAYLOAD_MIN_LENGTH = 6000;
const REPLICATION_PAYLOAD_MAX_LENGTH = 12000;
const REPLICATION_VECTOR_SEARCH_START = 2;
const REPLICATION_VECTOR_SEARCH_END = 16;
const TURRET_SNAPSHOT_PAYLOAD_MIN_LENGTH = 47;
const TURRET_SNAPSHOT_PAYLOAD_MAX_LENGTH = 63;

// These are the deterministic map-object network IDs used by the 16.14
// Summoner's Rift observer stream. The owner is the team defending the
// turret; a destroyed team-100 turret therefore increments team 200's score.
const SUMMONERS_RIFT_TURRET_OWNERS = Object.freeze([
  [0x40000088, 100],
  [0x4000008b, 100],
  [0x4000008c, 100],
  [0x4000008d, 100],
  [0x4000008e, 100],
  [0x40000092, 200],
  [0x40000093, 200],
  [0x40000094, 100],
  [0x40000096, 200],
  [0x40000097, 200],
  [0x40000098, 200],
  [0x4000009a, 100],
  [0x4000009b, 200],
  [0x400000a0, 200],
  [0x400000a1, 200],
  [0x400000a2, 100],
  [0x400000a3, 100],
  [0x400000a4, 200],
  [0x400000a5, 200],
  [0x400000a6, 100],
  [0x400000a7, 200],
  [0x400000ab, 100]
]);

export const SUMMONERS_RIFT_EXPERIENCE_THRESHOLDS = Object.freeze([
  0,
  280,
  660,
  1_140,
  1_720,
  2_400,
  3_180,
  4_060,
  5_040,
  6_120,
  7_300,
  8_580,
  9_960,
  11_440,
  13_020,
  14_700,
  16_480,
  18_360
]);

export const SUMMONERS_RIFT_TOP_EXPERIENCE_THRESHOLDS = Object.freeze([
  ...SUMMONERS_RIFT_EXPERIENCE_THRESHOLDS,
  20_340,
  22_420
]);

const HERO_MUTATION_TABLE = Buffer.from(
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

export const PATCH_16_14_CHAMPION_IDS = Object.freeze({
  Aatrox: 266,
  Ahri: 103,
  Akali: 84,
  Akshan: 166,
  Alistar: 12,
  Ambessa: 799,
  Amumu: 32,
  Anivia: 34,
  Annie: 1,
  Aphelios: 523,
  Ashe: 22,
  AurelionSol: 136,
  Aurora: 893,
  Azir: 268,
  Bard: 432,
  Belveth: 200,
  Blitzcrank: 53,
  Brand: 63,
  Braum: 201,
  Briar: 233,
  Caitlyn: 51,
  Camille: 164,
  Cassiopeia: 69,
  Chogath: 31,
  Corki: 42,
  Darius: 122,
  Diana: 131,
  Draven: 119,
  DrMundo: 36,
  Ekko: 245,
  Elise: 60,
  Evelynn: 28,
  Ezreal: 81,
  Fiddlesticks: 9,
  Fiora: 114,
  Fizz: 105,
  Galio: 3,
  Gangplank: 41,
  Garen: 86,
  Gnar: 150,
  Gragas: 79,
  Graves: 104,
  Gwen: 887,
  Hecarim: 120,
  Heimerdinger: 74,
  Hwei: 910,
  Illaoi: 420,
  Irelia: 39,
  Ivern: 427,
  Janna: 40,
  JarvanIV: 59,
  Jax: 24,
  Jayce: 126,
  Jhin: 202,
  Jinx: 222,
  Kaisa: 145,
  Kalista: 429,
  Karma: 43,
  Karthus: 30,
  Kassadin: 38,
  Katarina: 55,
  Kayle: 10,
  Kayn: 141,
  Kennen: 85,
  Khazix: 121,
  Kindred: 203,
  Kled: 240,
  KogMaw: 96,
  KSante: 897,
  Leblanc: 7,
  LeeSin: 64,
  Leona: 89,
  Lillia: 876,
  Lissandra: 127,
  Locke: 805,
  Lucian: 236,
  Lulu: 117,
  Lux: 99,
  Malphite: 54,
  Malzahar: 90,
  Maokai: 57,
  MasterYi: 11,
  Mel: 800,
  Milio: 902,
  MissFortune: 21,
  MonkeyKing: 62,
  Mordekaiser: 82,
  Morgana: 25,
  Naafiri: 950,
  Nami: 267,
  Nasus: 75,
  Nautilus: 111,
  Neeko: 518,
  Nidalee: 76,
  Nilah: 895,
  Nocturne: 56,
  Nunu: 20,
  Olaf: 2,
  Orianna: 61,
  Ornn: 516,
  Pantheon: 80,
  Poppy: 78,
  Pyke: 555,
  Qiyana: 246,
  Quinn: 133,
  Rakan: 497,
  Rammus: 33,
  RekSai: 421,
  Rell: 526,
  Renata: 888,
  Renekton: 58,
  Rengar: 107,
  Riven: 92,
  Rumble: 68,
  Ryze: 13,
  Samira: 360,
  Sejuani: 113,
  Senna: 235,
  Seraphine: 147,
  Sett: 875,
  Shaco: 35,
  Shen: 98,
  Shyvana: 102,
  Singed: 27,
  Sion: 14,
  Sivir: 15,
  Skarner: 72,
  Smolder: 901,
  Sona: 37,
  Soraka: 16,
  Swain: 50,
  Sylas: 517,
  Syndra: 134,
  TahmKench: 223,
  Taliyah: 163,
  Talon: 91,
  Taric: 44,
  Teemo: 17,
  Thresh: 412,
  Tristana: 18,
  Trundle: 48,
  Tryndamere: 23,
  TwistedFate: 4,
  Twitch: 29,
  Udyr: 77,
  Urgot: 6,
  Varus: 110,
  Vayne: 67,
  Veigar: 45,
  Velkoz: 161,
  Vex: 711,
  Vi: 254,
  Viego: 234,
  Viktor: 112,
  Vladimir: 8,
  Volibear: 106,
  Warwick: 19,
  Xayah: 498,
  Xerath: 101,
  XinZhao: 5,
  Yasuo: 157,
  Yone: 777,
  Yorick: 83,
  Yunara: 804,
  Yuumi: 350,
  Zaahen: 904,
  Zac: 154,
  Zed: 238,
  Zeri: 221,
  Ziggs: 115,
  Zilean: 26,
  Zoe: 142,
  Zyra: 143
});

function rotateRight8(value, bits) {
  const count = bits & 7;
  return ((value >>> count) | (value << (8 - count))) & 0xff;
}

function swapAdjacentBits(value) {
  return (((value & 0xd5) << 1) | ((value >>> 1) & 0x55)) & 0xff;
}

function rotateLeft8(value, bits) {
  return rotateRight8(value, 8 - (bits & 7));
}

function decodeMutatedVarint(payload, initialCursor, transform) {
  let cursor = initialCursor;
  let value = 0;
  let shift = 0;
  while (cursor < payload.length) {
    const current = transform(payload[cursor]);
    cursor += 1;
    value |= (current & 0x7f) << shift;
    if (current < 0x80) return { value: value >>> 0, cursor };
    shift += 7;
    if (shift > 28) throw new Error('Mutated varint is too long.');
  }
  throw new Error('Mutated varint is truncated.');
}

function heroByte(value) {
  let decoded = rotateRight8(value, 4);
  decoded = (decoded - 0x75) & 0xff;
  decoded = swapAdjacentBits(decoded);
  decoded = rotateRight8(decoded, 1) ^ 0xf5;
  return HERO_MUTATION_TABLE[decoded];
}

function replicationByte(value) {
  let decoded = ((value << 1) | (value >>> 7)) & 0xff;
  decoded ^= 0x11;
  decoded = HERO_MUTATION_TABLE[decoded];
  decoded = HERO_MUTATION_TABLE[decoded];
  decoded = rotateRight8(decoded, 1);
  decoded = (~decoded) & 0xff;
  decoded = HERO_MUTATION_TABLE[decoded];
  return rotateRight8(decoded, 5);
}

function inventoryCountByte(value) {
  let decoded = value ^ 0x51;
  decoded = swapAdjacentBits(decoded);
  decoded = (~decoded) & 0xff;
  decoded = (decoded - 0x34) & 0xff;
  decoded = HERO_MUTATION_TABLE[decoded];
  decoded = swapAdjacentBits(decoded);
  return decoded ^ 0xb7;
}

function inventoryItemIdByte(value) {
  let decoded = rotateRight8(value, 5) ^ 0x75;
  decoded = swapAdjacentBits(decoded);
  decoded = (decoded + 0x19) & 0xff;
  return rotateRight8(decoded, 3);
}

function inventorySlotByte(value) {
  let decoded = HERO_MUTATION_TABLE[value];
  decoded = rotateRight8(decoded, 5) ^ 0x9e;
  decoded = rotateRight8(decoded, 4);
  decoded = (decoded + 0x14) & 0xff;
  return decoded ^ 0x65;
}

function inventoryRecordShortAByte(value) {
  return HERO_MUTATION_TABLE[(value - 0x21) & 0xff];
}

function inventoryRecordShortBByte(value) {
  let decoded = HERO_MUTATION_TABLE[value];
  decoded = (decoded - 0x78) & 0xff;
  decoded = rotateRight8(decoded ^ 0x30, 4);
  decoded = HERO_MUTATION_TABLE[decoded];
  decoded = HERO_MUTATION_TABLE[rotateLeft8(decoded, 5)];
  return decoded;
}

function inventoryStateShortByte(value) {
  let decoded = rotateLeft8((value + 0x7e) & 0xff, 5) ^ 0xb3;
  decoded = HERO_MUTATION_TABLE[decoded] ^ 0xbb;
  decoded = HERO_MUTATION_TABLE[decoded];
  return swapAdjacentBits(decoded) ^ 0x24;
}

function inventoryHeaderField(payload, offset, bytes, bitOffset, width) {
  if (offset + bytes > payload.length) {
    throw new Error('Packet 129 has a truncated generated-schema header.');
  }
  const header = payload.readUIntLE(offset, bytes);
  return (header >>> bitOffset) & ((1 << width) - 1);
}

function skipInventoryBytes(payload, cursor, length) {
  const next = cursor + length;
  if (next > payload.length) {
    throw new Error('Packet 129 has a truncated generated-schema field.');
  }
  return next;
}

function skipInventoryVarint(payload, cursor, transform) {
  return decodeMutatedVarint(payload, cursor, transform).cursor;
}

const INVENTORY_RECORD_FIELDS = Object.freeze([
  { bitOffset: 12, dynamic: new Set([2, 4, 5, 7]), bytes: 4 },
  {
    bitOffset: 15,
    dynamic: new Set([0, 2, 5, 7]),
    transform: inventoryRecordShortAByte
  },
  { bitOffset: 18, dynamic: new Set([1, 2, 3, 4]), bytes: 4 },
  { bitOffset: 9, dynamic: new Set([0, 1, 5, 6]), bytes: 4 },
  { bitOffset: 6, dynamic: new Set([1, 4, 5, 7]), bytes: 4 },
  { bitOffset: 3, dynamic: new Set([1, 2, 3, 4]), bytes: 4 },
  {
    bitOffset: 0,
    dynamic: new Set([2, 4, 5, 6]),
    transform: inventoryRecordShortBByte
  },
  { bitOffset: 21, dynamic: new Set([2, 3, 6, 7]), bytes: 4 }
]);

function decodeInventoryItemId(payload, cursor, field) {
  const defaults = new Map([
    [7, 2],
    [4, 1],
    [2, 0xffffffff],
    [3, 0]
  ]);
  if (defaults.has(field)) return { value: defaults.get(field), cursor };
  if (![0, 1, 5, 6].includes(field)) {
    throw new Error(`Packet 129 has unsupported item-id field enum ${field}.`);
  }
  return decodeMutatedVarint(payload, cursor, inventoryItemIdByte);
}

function decodeInventorySlot(payload, cursor, field) {
  const defaults = new Map([
    [3, 1],
    [6, 0xff],
    [1, 2],
    [0, 0]
  ]);
  if (defaults.has(field)) return { value: defaults.get(field), cursor };
  if (![2, 4, 5, 7].includes(field)) {
    throw new Error(`Packet 129 has unsupported inventory-slot field enum ${field}.`);
  }
  if (cursor >= payload.length) {
    throw new Error('Packet 129 has a truncated inventory-slot field.');
  }
  return {
    value: inventorySlotByte(payload[cursor]),
    cursor: cursor + 1
  };
}

function decodeInventoryState(payload, initialCursor, expectedSlot) {
  const headerOffset = initialCursor;
  let cursor = skipInventoryBytes(payload, initialCursor, 3);
  const field = (bitOffset, width = 1) => (
    inventoryHeaderField(payload, headerOffset, 3, bitOffset, width)
  );

  const item = decodeInventoryItemId(payload, cursor, field(4, 3));
  cursor = item.cursor;
  const slot = decodeInventorySlot(payload, cursor, field(20, 3));
  cursor = slot.cursor;
  if (slot.value !== expectedSlot) {
    throw new Error(
      `Packet 129 serialized inventory slot ${slot.value}; expected ${expectedSlot}.`
    );
  }

  if (
    ![0, 1].includes(field(18))
    || field(3) !== 0
    || field(9) !== 0
    || field(7, 2) !== 1
    || field(19) !== 1
    || field(13, 2) !== 2
  ) {
    throw new Error('Packet 129 does not match the verified 16.14 item-state shape.');
  }

  const floatField = field(10, 3);
  if ([0, 1, 4, 5].includes(floatField)) {
    cursor = skipInventoryBytes(payload, cursor, 4);
  } else if (![2, 3, 6, 7].includes(floatField)) {
    throw new Error(`Packet 129 has unsupported item-state float enum ${floatField}.`);
  }

  const shortField = field(15, 3);
  if ([0, 3, 6, 7].includes(shortField)) {
    cursor = skipInventoryVarint(payload, cursor, inventoryStateShortByte);
  } else if (![1, 2, 4, 5].includes(shortField)) {
    throw new Error(`Packet 129 has unsupported item-state short enum ${shortField}.`);
  }

  const byteField = field(0, 3);
  if ([1, 4, 6, 7].includes(byteField)) {
    cursor = skipInventoryBytes(payload, cursor, 1);
  } else if (![0, 2, 3, 5].includes(byteField)) {
    throw new Error(`Packet 129 has unsupported item-state byte enum ${byteField}.`);
  }

  if (
    !Number.isInteger(item.value)
    || item.value < 0
    || item.value > 0xffffffff
  ) {
    throw new Error(`Packet 129 returned invalid item id ${item.value}.`);
  }
  return { itemId: item.value, cursor };
}

function decodeInventoryRecord(payload, initialCursor, expectedSlot) {
  const headerOffset = initialCursor;
  let cursor = skipInventoryBytes(payload, initialCursor, 4);
  for (const field of INVENTORY_RECORD_FIELDS) {
    const value = inventoryHeaderField(
      payload,
      headerOffset,
      4,
      field.bitOffset,
      3
    );
    if (!field.dynamic.has(value)) continue;
    cursor = field.transform
      ? skipInventoryVarint(payload, cursor, field.transform)
      : skipInventoryBytes(payload, cursor, field.bytes);
  }

  const defaultState = inventoryHeaderField(payload, headerOffset, 4, 24, 1);
  if (defaultState === 1) return { itemId: 0, cursor };
  if (defaultState !== 0) {
    throw new Error(`Packet 129 has unsupported item-state enum ${defaultState}.`);
  }
  return decodeInventoryState(payload, cursor, expectedSlot);
}

export function decodePatch1614InventoryPayload(input) {
  const payload = Buffer.from(input);
  if (payload.length < 64 || payload.length > 512) {
    throw new Error('Packet 129 does not match the verified 16.14 inventory shape.');
  }
  if (
    inventoryHeaderField(payload, 0, 1, 0, 1) !== 0
    || inventoryHeaderField(payload, 1, 1, 1, 3) !== 3
    || inventoryHeaderField(payload, 1, 1, 0, 1) !== 1
  ) {
    throw new Error('Packet 129 has an unsupported inventory-vector header.');
  }

  const countField = decodeMutatedVarint(payload, 2, inventoryCountByte);
  if (countField.value !== 10) {
    throw new Error(`Packet 129 contains ${countField.value} inventory records; expected ten.`);
  }
  const records = [];
  let cursor = countField.cursor;
  for (let expectedSlot = 9; expectedSlot >= 0; expectedSlot -= 1) {
    const record = decodeInventoryRecord(payload, cursor, expectedSlot);
    records.push({ slot: expectedSlot, itemId: record.itemId });
    cursor = record.cursor;
  }
  if (cursor !== payload.length) {
    throw new Error(
      `Packet 129 left ${payload.length - cursor} trailing inventory bytes.`
    );
  }
  return records.sort((left, right) => left.slot - right.slot);
}

export function decodePatch1614HeroSnapshotPayload(input) {
  const payload = Buffer.from(input);
  if (payload.length !== HERO_PAYLOAD_LENGTH || payload[0] !== 0xe8) {
    throw new Error('Packet 747 does not match the verified 16.14 hero-snapshot shape.');
  }
  const lengthField = decodeMutatedVarint(payload, 1, heroByte);
  if (
    lengthField.value !== HERO_VECTOR_LENGTH
    || payload.length - lengthField.cursor !== HERO_VECTOR_LENGTH
  ) {
    throw new Error('Packet 747 has an unexpected decoded vector length.');
  }

  const output = Buffer.allocUnsafe(HERO_VECTOR_LENGTH);
  let cursor = lengthField.cursor;
  let front = 0;
  let back = output.length - 1;
  while (front < back) {
    output[front] = heroByte(payload[cursor]);
    output[back] = heroByte(payload[cursor + 1]);
    cursor += 2;
    front += 1;
    back -= 1;
  }
  if (front === back) {
    output[front] = heroByte(payload[cursor]);
    cursor += 1;
  }
  if (cursor !== payload.length) {
    throw new Error('Packet 747 was not consumed exactly.');
  }
  return output;
}

function finiteFloat(vector, offset, label) {
  const value = vector.readFloatLE(offset);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Packet 747 contains an invalid ${label}.`);
  }
  return value;
}

export function levelFromExperience(
  experience,
  thresholds = SUMMONERS_RIFT_EXPERIENCE_THRESHOLDS
) {
  if (!Number.isFinite(experience) || experience < 0) {
    throw new Error('Champion experience must be a finite non-negative number.');
  }
  if (
    !Array.isArray(thresholds)
    || thresholds.length < 1
    || thresholds[0] !== 0
    || thresholds.some((value, index) => (
      !Number.isFinite(value)
      || value < 0
      || (index > 0 && value <= thresholds[index - 1])
    ))
  ) {
    throw new Error('Champion experience thresholds are invalid.');
  }
  let level = 1;
  for (let index = 1; index < thresholds.length; index += 1) {
    if (experience < thresholds[index]) break;
    level = index + 1;
  }
  return level;
}

export function decodePatch1614HeroStats(input) {
  const vector = decodePatch1614HeroSnapshotPayload(input);
  const teamId = vector.readUInt32LE(0x20);
  if (teamId !== 100 && teamId !== 200) {
    throw new Error(`Packet 747 contains invalid team id ${teamId}.`);
  }
  const experience = finiteFloat(vector, 0x28, 'experience');
  const laneMinions = finiteFloat(vector, 0x3c, 'lane-minion count');
  const neutralMinions = finiteFloat(vector, 0x40, 'neutral-minion count');
  return {
    teamId,
    experience,
    level: levelFromExperience(experience),
    score: {
      kills: vector.readUInt32LE(0x4c),
      deaths: vector.readUInt32LE(0x50),
      assists: vector.readUInt32LE(0x54),
      cs: Math.round(laneMinions + neutralMinions)
    },
    credits: {
      inhibitorsKilled: vector.readUInt32LE(0x78),
      inhibitorTakedowns: vector.readUInt32LE(0x7c),
      turretsKilled: vector.readUInt32LE(0x80),
      turretTakedowns: vector.readUInt32LE(0x84),
      barons: vector.readUInt32LE(0xa4),
      dragons: vector.readUInt32LE(0xa8),
      elderDragons: vector.readUInt32LE(0xac),
      riftHeralds: vector.readUInt32LE(0xb0),
      voidGrubs: vector.readUInt32LE(0xb4),
      atakhan: vector.readUInt32LE(0xb8)
    }
  };
}

export function decodePatch1614ReplicationPayload(input) {
  const payload = Buffer.from(input);
  if (
    payload.length < REPLICATION_PAYLOAD_MIN_LENGTH
    || payload.length > REPLICATION_PAYLOAD_MAX_LENGTH
  ) {
    throw new Error('Packet 107 does not match the verified 16.14 replication shape.');
  }

  const candidates = [];
  const searchEnd = Math.min(REPLICATION_VECTOR_SEARCH_END, payload.length);
  for (
    let offset = REPLICATION_VECTOR_SEARCH_START;
    offset < searchEnd;
    offset += 1
  ) {
    try {
      const lengthField = decodeMutatedVarint(payload, offset, replicationByte);
      // Packet 107 has one generated-schema byte after the replication vector.
      if (
        lengthField.value >= REPLICATION_PAYLOAD_MIN_LENGTH
        && lengthField.value <= REPLICATION_PAYLOAD_MAX_LENGTH
        && lengthField.cursor + lengthField.value === payload.length - 1
      ) {
        candidates.push(lengthField);
      }
    } catch {
      // Only one early offset is a structurally valid vector length.
    }
  }
  if (candidates.length !== 1) {
    throw new Error(
      `Packet 107 yielded ${candidates.length} replication vectors; expected one.`
    );
  }

  const [{ value: length, cursor }] = candidates;
  const output = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    output[index] = replicationByte(payload[cursor + index]);
  }
  return output;
}

export function decodePatch1614ReplicationRecords(input) {
  const vector = decodePatch1614ReplicationPayload(input);
  const records = [];
  let cursor = 0;

  while (cursor < vector.length) {
    if (vector.length - cursor < 5) {
      throw new Error('Packet 107 has a truncated replication-record header.');
    }
    const primaryMask = vector[cursor];
    const netId = vector.readUInt32LE(cursor + 1);
    cursor += 5;
    if (primaryMask === 0) {
      throw new Error('Packet 107 has a replication record with no groups.');
    }

    const groups = [];
    for (let group = 0; group < 8; group += 1) {
      if ((primaryMask & (1 << group)) === 0) continue;
      if (vector.length - cursor < 5) {
        throw new Error('Packet 107 has a truncated replication-group header.');
      }
      const secondaryMask = vector.readUInt32LE(cursor);
      const dataLength = vector[cursor + 4];
      cursor += 5;
      if (vector.length - cursor < dataLength) {
        throw new Error('Packet 107 has truncated replication-group data.');
      }
      groups.push({
        group,
        secondaryMask,
        data: Buffer.from(vector.subarray(cursor, cursor + dataLength))
      });
      cursor += dataLength;
    }
    records.push({ netId, primaryMask, groups });
  }

  if (records.length < 10 || records.length > 256) {
    throw new Error(
      `Packet 107 yielded ${records.length} replication records; expected 10–256.`
    );
  }
  return records;
}

function turretAliveFromPayload(input) {
  const payload = Buffer.from(input);
  if (
    payload.length < TURRET_SNAPSHOT_PAYLOAD_MIN_LENGTH
    || payload.length > TURRET_SNAPSHOT_PAYLOAD_MAX_LENGTH
    || (payload[2] & 0xf0) !== 0xd0
  ) {
    throw new Error(
      'Packet 815 does not match the verified 16.14 turret-snapshot shape.'
    );
  }
  // The packet's generated-schema header is a 20-bit little-endian field
  // table. RVA 0xF0527A reads bit offset 3, width 1 into the client's
  // AITurret snapshot object. Client-assisted tracing established 1=alive.
  return ((payload[0] >>> 3) & 1) === 1;
}

export function decodePatch1614TurretSnapshot(blocks) {
  if (!Array.isArray(blocks)) {
    throw new Error('The 16.14 turret decoder requires keyframe blocks.');
  }
  const expectedIds = new Set(
    SUMMONERS_RIFT_TURRET_OWNERS.map(([networkId]) => networkId)
  );
  const matching = blocks.filter((block) => (
    block.packetId === 815 && expectedIds.has(block.param)
  ));
  if (matching.length === 0) return null;
  if (matching.length !== SUMMONERS_RIFT_TURRET_OWNERS.length) {
    throw new Error(
      `Packet 815 contains ${matching.length} Summoner's Rift turret snapshots; expected 22.`
    );
  }

  const byNetworkId = new Map();
  for (const block of matching) {
    if (byNetworkId.has(block.param)) {
      throw new Error(
        `Packet 815 contains duplicate turret network id 0x${block.param.toString(16)}.`
      );
    }
    if (!Buffer.isBuffer(block.payload) || block.payload.length !== block.length) {
      throw new Error('Packet 815 does not retain its complete turret payload.');
    }
    byNetworkId.set(block.param, turretAliveFromPayload(block.payload));
  }

  const destroyedByOwner = new Map([[100, 0], [200, 0]]);
  for (const [networkId, ownerTeamId] of SUMMONERS_RIFT_TURRET_OWNERS) {
    if (!byNetworkId.has(networkId)) {
      throw new Error(
        `Packet 815 is missing turret network id 0x${networkId.toString(16)}.`
      );
    }
    if (!byNetworkId.get(networkId)) {
      destroyedByOwner.set(
        ownerTeamId,
        destroyedByOwner.get(ownerTeamId) + 1
      );
    }
  }
  return {
    100: destroyedByOwner.get(200),
    200: destroyedByOwner.get(100)
  };
}

function rosterAlternating(value) {
  let decoded = swapAdjacentBits(value);
  decoded = (decoded + 0x28) & 0xff;
  decoded = swapAdjacentBits(decoded);
  decoded = (~decoded) & 0xff;
  decoded = swapAdjacentBits(decoded);
  return (decoded + 0x0c) & 0xff;
}

function rosterReverse(value) {
  let decoded = (value - 0x37) & 0xff;
  decoded = rotateRight8(decoded, 2);
  decoded = (decoded - 0x5e) & 0xff;
  return swapAdjacentBits(decoded);
}

function rosterForward(value) {
  let decoded = (value - 0x21) & 0xff;
  decoded = rotateRight8(decoded, 3);
  decoded = (decoded - 0x6a) & 0xff;
  decoded = rotateRight8(decoded, 4);
  decoded = (~decoded) & 0xff;
  return rotateRight8(decoded, 1);
}

function decodeMutatedString(payload, offset, transform, order) {
  const lengthField = decodeMutatedVarint(payload, offset, transform);
  if (
    lengthField.value < 1
    || lengthField.value > 32
    || lengthField.cursor + lengthField.value > payload.length
  ) {
    return null;
  }
  let cursor = lengthField.cursor;
  const output = Buffer.allocUnsafe(lengthField.value);
  if (order === 'forward') {
    for (let index = 0; index < output.length; index += 1) {
      output[index] = transform(payload[cursor]);
      cursor += 1;
    }
  } else if (order === 'reverse') {
    for (let index = output.length - 1; index >= 0; index -= 1) {
      output[index] = transform(payload[cursor]);
      cursor += 1;
    }
  } else {
    let front = 0;
    let back = output.length - 1;
    while (front < back) {
      output[front] = transform(payload[cursor]);
      output[back] = transform(payload[cursor + 1]);
      cursor += 2;
      front += 1;
      back -= 1;
    }
    if (front === back) output[front] = transform(payload[cursor]);
  }
  const value = output.toString('utf8');
  return Buffer.from(value, 'utf8').equals(output) ? value : null;
}

const ROSTER_VARIANTS = Object.freeze([
  { transform: rosterAlternating, order: 'alternating' },
  { transform: rosterReverse, order: 'reverse' },
  { transform: rosterForward, order: 'forward' }
]);

// Packet 761's vector helper places records at alternating front/back slots.
const ROSTER_WIRE_SLOTS = Object.freeze([1, 2, 10, 3, 9, 4, 8, 5, 7, 6]);

export function decodePatch1614RosterPayload(
  input,
  championIds = PATCH_16_14_CHAMPION_IDS
) {
  const payload = Buffer.from(input);
  if (
    payload.length < ROSTER_PAYLOAD_MIN_LENGTH
    || payload.length > ROSTER_PAYLOAD_MAX_LENGTH
  ) {
    throw new Error('Packet 761 does not match the verified 16.14 roster shape.');
  }
  const hits = [];
  for (let offset = 0; offset < payload.length; offset += 1) {
    const matches = [];
    for (const variant of ROSTER_VARIANTS) {
      try {
        const champion = decodeMutatedString(
          payload,
          offset,
          variant.transform,
          variant.order
        );
        if (champion && Object.hasOwn(championIds, champion)) matches.push(champion);
      } catch {
        // Invalid offsets are expected while scanning the generated schema.
      }
    }
    const unique = [...new Set(matches)];
    if (unique.length > 1) {
      throw new Error(`Packet 761 has an ambiguous champion field at byte ${offset}.`);
    }
    if (unique.length === 1) hits.push({ offset, champion: unique[0] });
  }
  if (hits.length !== 10) {
    throw new Error(`Packet 761 yielded ${hits.length} champion rows; expected ten.`);
  }
  return hits
    .map((hit, wireIndex) => ({
      participantSlot: ROSTER_WIRE_SLOTS[wireIndex],
      championName: hit.champion,
      championId: Number(championIds[hit.champion])
    }))
    .sort((left, right) => left.participantSlot - right.participantSlot);
}

export const PATCH_16_14_PACKET_IDS = Object.freeze({
  replication: 107,
  inventory: 129,
  heroSnapshot: 747,
  roster: 761,
  turretSnapshot: 815
});

