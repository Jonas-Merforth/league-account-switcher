import {
  levelFromExperience,
  PATCH_16_14_CHAMPION_IDS
} from './patch-16-14-codecs.js';

const HERO_VECTOR_LENGTH = 1_476;
const HERO_PAYLOAD_LENGTH = 1_479;
const ROSTER_PAYLOAD_MIN_LENGTH = 800;
const ROSTER_PAYLOAD_MAX_LENGTH = 1_300;
const TURRET_SNAPSHOT_PAYLOAD_MIN_LENGTH = 47;
const TURRET_SNAPSHOT_PAYLOAD_MAX_LENGTH = 63;

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

// The 16.15 client WAD roster has the same champion names and numeric IDs as
// the immutable 16.14 allowlist. Future profiles must compare their own WAD
// roster before choosing whether to reuse it.
export const PATCH_16_15_CHAMPION_IDS = PATCH_16_14_CHAMPION_IDS;

// These deterministic Summoner's Rift map-object IDs did not change in 16.15.
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

function rotateRight8(value, bits) {
  return ((value >>> bits) | (value << (8 - bits))) & 0xff;
}

function swapAdjacentBits(value) {
  return (((value & 0xd5) << 1) | ((value >>> 1) & 0x55)) & 0xff;
}

function heroByte(value) {
  const tableIndex = swapAdjacentBits(value) ^ 0x4d;
  return rotateRight8(MUTATION_TABLE[tableIndex], 1);
}

function decodeMutatedVarint(payload, initialCursor, transform) {
  let cursor = initialCursor;
  let value = 0;
  let shift = 0;
  while (cursor < payload.length && shift <= 28) {
    const current = transform(payload[cursor]);
    cursor += 1;
    value |= (current & 0x7f) << shift;
    if ((current & 0x80) === 0) return { value: value >>> 0, cursor };
    shift += 7;
  }
  throw new Error('16.15 packet contains an invalid mutated varint.');
}

export function decodePatch1615HeroSnapshotPayload(input) {
  const payload = Buffer.from(input);
  if (payload.length !== HERO_PAYLOAD_LENGTH || payload[0] !== 0xaf) {
    throw new Error('Packet 670 does not match the verified 16.15 hero-snapshot shape.');
  }
  const lengthField = decodeMutatedVarint(payload, 1, heroByte);
  if (
    lengthField.value !== HERO_VECTOR_LENGTH
    || payload.length - lengthField.cursor !== HERO_VECTOR_LENGTH
  ) {
    throw new Error('Packet 670 has an unexpected decoded vector length.');
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
    throw new Error('Packet 670 was not consumed exactly.');
  }
  return output;
}

function finiteFloat(vector, offset, label) {
  const value = vector.readFloatLE(offset);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Packet 670 contains an invalid ${label}.`);
  }
  return value;
}

export function decodePatch1615HeroStats(input) {
  const vector = decodePatch1615HeroSnapshotPayload(input);
  const teamId = vector.readUInt32LE(0x20);
  if (teamId !== 100 && teamId !== 200) {
    throw new Error(`Packet 670 contains invalid team id ${teamId}.`);
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
  if (order === 'reverse') {
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
  { transform: rosterReverseB, order: 'reverse' },
  { transform: rosterReverseC, order: 'reverse' },
  { transform: rosterAlternatingF, order: 'alternating' }
]);

export function decodePatch1615RosterPayload(
  input,
  championIds = PATCH_16_15_CHAMPION_IDS
) {
  const payload = Buffer.from(input);
  if (
    payload.length < ROSTER_PAYLOAD_MIN_LENGTH
    || payload.length > ROSTER_PAYLOAD_MAX_LENGTH
  ) {
    throw new Error('Packet 315 does not match the verified 16.15 roster shape.');
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
      throw new Error(`Packet 315 has an ambiguous champion field at byte ${offset}.`);
    }
    if (unique.length === 1) hits.push({ offset, champion: unique[0] });
  }
  if (hits.length !== 10) {
    throw new Error(`Packet 315 yielded ${hits.length} champion rows; expected ten.`);
  }
  return hits.map((hit, index) => ({
    participantSlot: index + 1,
    championName: hit.champion,
    championId: Number(championIds[hit.champion])
  }));
}

function turretAliveFromPayload(input) {
  const payload = Buffer.from(input);
  if (
    payload.length < TURRET_SNAPSHOT_PAYLOAD_MIN_LENGTH
    || payload.length > TURRET_SNAPSHOT_PAYLOAD_MAX_LENGTH
    || (payload[2] & 0xfe) !== 0x54
  ) {
    throw new Error(
      'Packet 298 does not match the verified 16.15 turret-snapshot shape.'
    );
  }
  // The client reads bit offset 16, width 1 from this generated header.
  return (payload[2] & 1) === 1;
}

export function decodePatch1615TurretSnapshot(blocks) {
  if (!Array.isArray(blocks)) {
    throw new Error('The 16.15 turret decoder requires keyframe blocks.');
  }
  const expectedIds = new Set(
    SUMMONERS_RIFT_TURRET_OWNERS.map(([networkId]) => networkId)
  );
  const matching = blocks.filter((block) => (
    block.packetId === PATCH_16_15_PACKET_IDS.turretSnapshot
    && expectedIds.has(block.param)
  ));
  if (matching.length === 0) return null;
  if (matching.length !== SUMMONERS_RIFT_TURRET_OWNERS.length) {
    throw new Error(
      `Packet 298 contains ${matching.length} Summoner's Rift turret snapshots; expected 22.`
    );
  }

  const byNetworkId = new Map();
  for (const block of matching) {
    if (byNetworkId.has(block.param)) {
      throw new Error(
        `Packet 298 contains duplicate turret network id 0x${block.param.toString(16)}.`
      );
    }
    if (!Buffer.isBuffer(block.payload) || block.payload.length !== block.length) {
      throw new Error('Packet 298 does not retain its complete turret payload.');
    }
    byNetworkId.set(block.param, turretAliveFromPayload(block.payload));
  }

  const destroyedByOwner = new Map([[100, 0], [200, 0]]);
  for (const [networkId, ownerTeamId] of SUMMONERS_RIFT_TURRET_OWNERS) {
    if (!byNetworkId.has(networkId)) {
      throw new Error(
        `Packet 298 is missing turret network id 0x${networkId.toString(16)}.`
      );
    }
    if (!byNetworkId.get(networkId)) {
      destroyedByOwner.set(ownerTeamId, destroyedByOwner.get(ownerTeamId) + 1);
    }
  }
  return {
    100: destroyedByOwner.get(200),
    200: destroyedByOwner.get(100)
  };
}

export const PATCH_16_15_PACKET_IDS = Object.freeze({
  inventory: 370,
  heroSnapshot: 670,
  roster: 315,
  turretSnapshot: 298
});
