import {
  levelFromExperience,
  PATCH_16_14_CHAMPION_IDS
} from './patch-16-14-codecs.js';

const HERO_VECTOR_LENGTH = 1_260;
const HERO_PAYLOAD_LENGTH = 1_263;
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

// The exact-case 16.19 base champion WAD set still matches this 173-entry
// roster (excluding the generic TFTChampion asset). Keep the alias patch-local.
export const PATCH_16_19_CHAMPION_IDS = PATCH_16_14_CHAMPION_IDS;

const SUMMONERS_RIFT_TURRET_OWNERS = Object.freeze([
  [0x40000088, 100], [0x4000008b, 100], [0x4000008c, 100],
  [0x4000008d, 100], [0x4000008e, 100], [0x40000092, 200],
  [0x40000093, 200], [0x40000094, 100], [0x40000096, 200],
  [0x40000097, 200], [0x40000098, 200], [0x4000009a, 100],
  [0x4000009b, 200], [0x400000a0, 200], [0x400000a1, 200],
  [0x400000a2, 100], [0x400000a3, 100], [0x400000a4, 200],
  [0x400000a5, 200], [0x400000a6, 100], [0x400000a7, 200],
  [0x400000ab, 100]
]);

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

// The official 16.19 macOS x86-64 reader at VA 0x101416520 writes
// the 1,260-byte hero vector backwards. See the patch-upgrade evidence log.
function heroByte(value) {
  const rotated = rotateLeft8((value + 0x11) & 0xff, 6);
  return (MUTATION_TABLE[swapAdjacentBits(rotated)] + 0x39) & 0xff;
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
  throw new Error('16.19 packet contains an invalid mutated varint.');
}

export function decodePatch1619HeroSnapshotPayload(input) {
  const payload = Buffer.from(input);
  if (payload.length !== HERO_PAYLOAD_LENGTH || payload[0] !== 0x67) {
    throw new Error('Packet 137 does not match the verified 16.19 hero-snapshot shape.');
  }
  const lengthField = decodeMutatedVarint(payload, 1, heroByte);
  if (
    lengthField.value !== HERO_VECTOR_LENGTH
    || payload.length - lengthField.cursor !== HERO_VECTOR_LENGTH
  ) {
    throw new Error('Packet 137 has an unexpected decoded vector length.');
  }
  const output = Buffer.allocUnsafe(HERO_VECTOR_LENGTH);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = heroByte(
      payload[lengthField.cursor + (HERO_VECTOR_LENGTH - 1 - index)]
    );
  }
  return output;
}

function finiteFloat(vector, offset, label) {
  const value = vector.readFloatLE(offset);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Packet 137 contains an invalid ${label}.`);
  }
  return value;
}

export function decodePatch1619HeroStats(input) {
  const vector = decodePatch1619HeroSnapshotPayload(input);
  const teamId = vector.readUInt32LE(0x20);
  if (teamId !== 100 && teamId !== 200) {
    throw new Error(`Packet 137 contains invalid team id ${teamId}.`);
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

// Canonical champion field at record +0x10. Readers A/B write backwards;
// C alternates writes from the left and right edges toward the middle.
// The enclosing 328-byte record vector is itself written backwards.
function rosterReaderA(value) {
  let decoded = rotateRight8(value, 1) ^ 0x72;
  decoded = swapAdjacentBits(rotateLeft8(decoded, 3));
  return rotateLeft8(MUTATION_TABLE[decoded], 3);
}

function rosterReaderB(value) {
  let decoded = rotateRight8(MUTATION_TABLE[(value + 0x3f) & 0xff], 1);
  decoded = (((decoded ^ 0x27) + 0x5e) & 0xff) ^ 0x7a;
  return swapAdjacentBits(decoded);
}

function rosterReaderC(value) {
  const decoded = MUTATION_TABLE[(rotateLeft8(value, 5) + 0x98) & 0xff];
  const permuted = ((decoded << 2) & 0x54) | (decoded & 0xaa) | ((decoded >>> 6) & 1);
  return (permuted + 8) & 0xff;
}

function decodeMutatedString(payload, offset, { transform, outsideIn }) {
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
  for (let index = 0; index < output.length; index += 1) {
    const destination = outsideIn
      ? (index % 2 === 0 ? index / 2 : output.length - 1 - Math.floor(index / 2))
      : output.length - 1 - index;
    output[destination] = transform(payload[cursor]);
    cursor += 1;
  }
  const value = output.toString('utf8');
  return Buffer.from(value, 'utf8').equals(output) ? value : null;
}

const ROSTER_READERS = Object.freeze([
  { transform: rosterReaderA, outsideIn: false },
  { transform: rosterReaderB, outsideIn: false },
  { transform: rosterReaderC, outsideIn: true }
]);

export function decodePatch1619RosterPayload(
  input,
  championIds = PATCH_16_19_CHAMPION_IDS
) {
  const payload = Buffer.from(input);
  if (
    payload.length < ROSTER_PAYLOAD_MIN_LENGTH
    || payload.length > ROSTER_PAYLOAD_MAX_LENGTH
  ) {
    throw new Error('Packet 453 does not match the verified 16.19 roster shape.');
  }
  const hits = [];
  for (let offset = 0; offset < payload.length; offset += 1) {
    const matches = [];
    for (const transform of ROSTER_READERS) {
      try {
        const champion = decodeMutatedString(payload, offset, transform);
        if (champion && Object.hasOwn(championIds, champion)) matches.push(champion);
      } catch {
        // Invalid offsets are expected while scanning the generated schema.
      }
    }
    const unique = [...new Set(matches)];
    if (unique.length > 1) {
      throw new Error(`Packet 453 has an ambiguous champion field at byte ${offset}.`);
    }
    if (unique.length === 1) hits.push({ offset, champion: unique[0] });
  }
  if (hits.length !== 10) {
    throw new Error(`Packet 453 yielded ${hits.length} champion rows; expected ten.`);
  }
  return hits
    .slice()
    .reverse()
    .map((hit, index) => ({
      participantSlot: index + 1,
      championName: hit.champion,
      championId: Number(championIds[hit.champion])
    }));
}

function turretDestroyedFromPayload(input) {
  const payload = Buffer.from(input);
  if (
    payload.length < TURRET_SNAPSHOT_PAYLOAD_MIN_LENGTH
    || payload.length > TURRET_SNAPSHOT_PAYLOAD_MAX_LENGTH
    || (payload[0] & 0x40) !== 0
    || (payload[1] & 0x70) !== 0x20
    || (payload[2] & 0xf0) !== 0xf0
  ) {
    throw new Error('Packet 1099 does not match the verified 16.19 turret-snapshot shape.');
  }
  // VA 0x101359920: bit 0 controls object +0x4d, bit 7 selects the
  // generated default for +0x44. Both clear for destroyed turrets. Bit 11
  // switches +0x10 away from its standing default; require agreement.
  const destroyed = (payload[0] & 1) === 0;
  const mirrored = (payload[0] & 0x80) === 0;
  const changedState = (payload[1] & 0x08) !== 0;
  if (destroyed !== mirrored || destroyed !== changedState) {
    throw new Error('Packet 1099 turret state fields disagree.');
  }
  return destroyed;
}

export function decodePatch1619TurretSnapshot(blocks) {
  if (!Array.isArray(blocks)) {
    throw new Error('The 16.19 turret decoder requires keyframe blocks.');
  }
  const expectedIds = new Set(SUMMONERS_RIFT_TURRET_OWNERS.map(([id]) => id));
  const matching = blocks.filter((block) => (
    block.packetId === PATCH_16_19_PACKET_IDS.turretSnapshot
    && expectedIds.has(block.param)
  ));
  if (matching.length === 0) return null;
  if (matching.length !== SUMMONERS_RIFT_TURRET_OWNERS.length) {
    throw new Error(`Packet 1099 contains ${matching.length} Summoner's Rift turret snapshots; expected 22.`);
  }
  const byNetworkId = new Map();
  for (const block of matching) {
    if (byNetworkId.has(block.param)) {
      throw new Error(`Packet 1099 contains duplicate turret network id 0x${block.param.toString(16)}.`);
    }
    if (!Buffer.isBuffer(block.payload) || block.payload.length !== block.length) {
      throw new Error('Packet 1099 does not retain its complete turret payload.');
    }
    byNetworkId.set(block.param, turretDestroyedFromPayload(block.payload));
  }
  const destroyedByOwner = new Map([[100, 0], [200, 0]]);
  for (const [networkId, ownerTeamId] of SUMMONERS_RIFT_TURRET_OWNERS) {
    if (!byNetworkId.has(networkId)) {
      throw new Error(`Packet 1099 is missing turret network id 0x${networkId.toString(16)}.`);
    }
    if (byNetworkId.get(networkId)) {
      destroyedByOwner.set(ownerTeamId, destroyedByOwner.get(ownerTeamId) + 1);
    }
  }
  return {
    100: destroyedByOwner.get(200),
    200: destroyedByOwner.get(100)
  };
}

export const PATCH_16_19_PACKET_IDS = Object.freeze({
  inventory: 855,
  heroSnapshot: 137,
  roster: 453,
  turretSnapshot: 1099
});
