// Standalone application-packet parser for the type 743 envelope on 16.22.8348910.
// The caller must verify the build and transport checksum before decoding.
// Table offsets in the pinned macOS client are 0x10212c610 and 0x10210e200.
import { byte, decodeNetId, netIdTable, PacketReader, readDisplayVarint, readOwner, rotateLeft, swapBits } from './livePacketReader.js';
import { decodeCombatBody } from './damageCombatBody.js';
import { heroStatFields } from './heroStats.js';
import { unfoldReplicationVector } from './liveReplication.js';
export { damagePacketOwner } from './livePacketReader.js';

const schemaDefaults = [1, 0xffffffff, 0, null, 2, null, null, null];
const kindDefaults = [null, null, 0, 2, 65535, null, 1, null];

const decodeLength = (value) => rotateLeft(byte(rotateLeft(byte(value + 0x62), 2) + 0x82), 4);
const decodeSchema = (value) => byte((rotateLeft(netIdTable[byte(netIdTable[value] + 0x51)], 7) ^ 0x5f) + 0xfc);
const decodeKind = (value) => swapBits(byte(~rotateLeft(netIdTable[value], 7)));

// 743 also carries server-issued champion kill and assist notifications.
// Decode the envelope once and keep these out of the personal hit stream.
export function decodeCombatEvent(data) {
  if (!(data instanceof Uint8Array) || !data.length || data.length >= 0x7000) {
    throw new RangeError('Invalid damage event envelope size');
  }
  const reader = new PacketReader(data);
  const owner = readOwner(reader);
  const mask = reader.next();
  const size = (mask & 1) ? 0 : reader.varint(decodeLength, 0x7000);
  const vector = reader.vector(size);
  const schema = schemaDefaults[mask >>> 4 & 7] ?? reader.varint(decodeSchema, 0xffffffff);
  const kind = kindDefaults[mask >>> 1 & 7] ?? reader.varint(decodeKind, 0xffff);
  if (reader.offset !== data.length) throw new RangeError('Trailing bytes in damage event envelope');
  return decodeCombatBody(owner, schema, kind, vector, decodeLength);
}

export function decodeDamageStatEvent(data) {
  const event = decodeCombatEvent(data);
  return event?.statDirection ? event : null;
}

// Type 43 creates a hero object. Follow the client's field selectors at
// 0x101048050 and decode the object ID and model used by 0x1006ebd70.
const decodeHeroId = (value) => rotateLeft(swapBits(rotateLeft(swapBits(byte(value + 0xb)), 7) ^ 0xf6), 3) ^ 0x2e;

const recapDurationDefaults = [1, -1, 0, null, 2, null, null, null];
const recapStringLengths = [
  (value) => byte(0xc0 - rotateLeft(value, 4)),
  null,
  (value) => byte(netIdTable[netIdTable[byte((swapBits(value) ^ 0x41) + 0x72)]] + 0xbd),
  (value) => rotateLeft(byte((netIdTable[value] ^ 0x5e) + 0x74) ^ 0xe8, 1)
];
const decodeRecapCount = (value) => byte(0x5c - netIdTable[byte(((value + 0x90) ^ 0xd6) + 0x8e) ^ 0x2a]);
const decodeRecapDetailCount = (value) => byte(rotateLeft(value ^ 0xd8, 6) + 0x21);
const decodeRecapDurationByte = (value) => swapBits(netIdTable[byte(rotateLeft(value, 3) + 0x7e)] ^ 0x89);
const decodeRecapDetailIndex = (value) => byte(rotateLeft(byte(~rotateLeft(value, 3)), 4) + 0x93);
const recapFloatFields = [0, 1, 2, 5];
const recapAmountFields = [2, 4, 6, 7];
const decodeRecapPhysical = (value) => rotateLeft(swapBits(byte((netIdTable[swapBits(rotateLeft(value, 2))] ^ 0x88) + 0x8e)), 4);
const decodeRecapTrue = (value) => byte(((0xd3 - netIdTable[value ^ 255]) ^ 0xe1) + 0x89);
const decodeRecapMagic = (value) => netIdTable[rotateLeft(netIdTable[value ^ 0xc6] ^ 255, 6)];
const recapSchoolDefaults = {
  physical: [null, null, null, 0, 2, null, -1, 1],
  true: [0, -1, null, 1, null, 2, null, null],
  magic: [null, 0, null, 2, 1, -1, null, null]
};

function readRecapDamageDetail(reader, outgoing) {
  const [first, second, third] = reader.vector(3);
  const readAmount = (school, selector, transform) => {
    const fallback = recapSchoolDefaults[school][selector];
    const data = fallback == null ? reader.vector(4) : null;
    if (!outgoing?.valid) return;
    const decoded = data && Buffer.from(data).map(transform);
    const amount = fallback ?? (school === 'true' ? decoded.readFloatLE() : decoded.readFloatBE());
    if (!Number.isFinite(amount) || amount < 0) {
      outgoing.valid = false;
      return;
    }
    outgoing.schools[school] += amount;
    // The recap consumer rounds each detail up before combining rows.
    outgoing.displayTypes[school] += Math.ceil(amount);
  };
  readAmount('physical', first >>> 5, decodeRecapPhysical);
  readAmount('true', first >>> 1 & 7, decodeRecapTrue);
  if ([0, 1, 3, 4].includes((second >>> 6) + (third & 1) * 4)) {
    reader.varint(decodeRecapDetailIndex, 0xffffffff);
  }
  if ([1, 2, 5, 7].includes(second >>> 3 & 7)) reader.varint(decodeRecapDurationByte, 0xffffffff);
  readAmount('magic', second & 7, decodeRecapMagic);
}

function readRecapDamageEntry(reader, outgoing) {
  const flags = reader.next();
  const length = recapStringLengths[flags >>> 1 & 3];
  if (length) reader.vector(reader.varint(length, 0x7000));
  if (!(flags & 1)) {
    const count = reader.varint(decodeRecapDetailCount, 0x7000);
    for (let i = 0; i < count; i++) readRecapDamageDetail(reader, outgoing);
  }
  if (![2, 4].includes(flags >>> 3 & 7)) reader.varint(decodeHeroId, 0xffffffff, 0);
}

// Type 1074 supplies the fight duration and a separate, final entry for the
// local player's outgoing champion damage (consumer at 0x100bd5cb0).
export function decodeDeathRecap(data) {
  if (!(data instanceof Uint8Array) || !data.length || data.length >= 0x7000) {
    throw new RangeError('Invalid death recap size');
  }
  const reader = new PacketReader(data);
  readOwner(reader);
  const [first, second, third] = reader.vector(3);
  if (!(second & 2)) {
    const count = reader.varint(decodeRecapCount, 0x7000);
    for (let i = 0; i < count; i++) readRecapDamageEntry(reader);
  }
  if ([0, 2, 6, 7].includes((second >>> 6) + (third & 1) * 4)) reader.vector(4);
  if (recapAmountFields.includes(first & 7)) reader.vector(4);
  if (![2, 4].includes((first >>> 6) + (second & 1) * 4)) reader.varint(decodeHeroId, 0xffffffff, 0);
  const durationField = second >>> 2 & 7;
  const duration = recapDurationDefaults[durationField] ??
    Buffer.from(reader.vector(4)).map(decodeRecapDurationByte).readFloatLE();
  if (recapFloatFields.includes(first >>> 3 & 7)) reader.vector(4);
  const schools = { physical: 0, magic: 0, true: 0 };
  const outgoing = { schools, displayTypes: { ...schools }, valid: true };
  if (!(second & 0x20)) readRecapDamageEntry(reader, outgoing);
  if (reader.offset !== data.length || !Number.isFinite(duration)) throw new RangeError('Invalid death recap fields');
  return { duration: duration >= 0 ? duration : null, schools: outgoing.valid ? schools : null,
    displayTypes: outgoing.valid ? outgoing.displayTypes : null };
}

export function decodeDeathRecapDuration(data) {
  return decodeDeathRecap(data).duration;
}

const decodeDisplayNameLength = [
  null,
  (value) => rotateLeft(value, 4) ^ 0x5a,
  (value) => byte(swapBits(byte(rotateLeft(value ^ 0x24, 2) + 0x83) ^ 0x8d) + 0xad),
  (value) => rotateLeft(netIdTable[byte(rotateLeft(value ^ 255, 5) + 0xc)], 7)
];
const decodeHeroModel = [
  null,
  (value) => byte(netIdTable[swapBits(rotateLeft(byte(0x54 - swapBits(value)), 5))] + 0xd7),
  (value) => {
    const index = rotateLeft(byte(swapBits(rotateLeft(value, 5)) - 8) ^ 0xc5, 2);
    return netIdTable[netIdTable[index]];
  },
  (value) => netIdTable[rotateLeft(byte(0x29 - swapBits(rotateLeft(swapBits(value) ^ 255, 3))), 1)]
];

export function decodeDamageHeroSpawn(data) {
  if (!(data instanceof Uint8Array) || !data.length || data.length >= 0x7000) {
    throw new RangeError('Invalid hero spawn size');
  }
  const reader = new PacketReader(data);
  readOwner(reader);
  const flags = reader.vector(6);
  const [first, second, third, fourth, fifth, sixth] = flags;

  // Advance over fields the meter does not use, following each field's
  // fixed width, encoded length or default value in the client reader.
  if ([0, 3, 4, 7].includes(fifth >>> 5)) reader.next();
  if ([0, 5, 6, 7].includes(sixth >>> 4 & 7)) reader.next();
  if (fourth & 4) reader.vector(12);
  const idField = fifth >>> 2 & 7;
  const encodedId = idField === 2 || idField === 4 ? 0 : reader.varint(decodeHeroId, 0xffffffff, 0);
  const id = ((encodedId & 0xffffff) ? encodedId ^ 0x40000000 : encodedId) >>> 0;
  if ([0, 2, 3, 6].includes(fourth >>> 5)) reader.vector(4);
  if ([0, 4, 5, 6].includes(second >>> 5)) reader.next();
  if ([0, 1, 5, 6].includes((fourth & 3) * 2 + (third >>> 7))) reader.vector(4);

  const nameDecoder = decodeDisplayNameLength[fourth >>> 3 & 3];
  if (nameDecoder) reader.vector(reader.varint(nameDecoder, 0x7000));
  if ([0, 1, 2, 5].includes(sixth >>> 1 & 7)) reader.next();
  if (third & 1) reader.next();
  if ([0, 2, 3, 6].includes(third >>> 4 & 7)) reader.next();
  if ([1, 3, 5, 7].includes(first >>> 1 & 7)) reader.next();
  if ([1, 2, 5, 6].includes((first >>> 6) + (second & 1) * 4)) reader.vector(4);
  if (second & 0x10) reader.vector(12);

  const modelEncoding = third >>> 1 & 3;
  const modelDecoder = decodeHeroModel[modelEncoding];
  const modelBytes = modelDecoder ? reader.vector(reader.varint(modelDecoder, 128)) : [];
  const model = Buffer.alloc(modelBytes.length);
  for (let i = 0; i < modelBytes.length; i++) {
    const index = modelEncoding === 3 ? modelBytes.length - 1 - i
      : i % 2 ? modelBytes.length - 1 - (i >>> 1) : i >>> 1;
    model[index] = modelDecoder(modelBytes[i]);
  }
  if (first & 1) reader.next();
  if ([1, 2, 5, 6].includes(second >>> 1 & 7)) {
    reader.varint((value) => byte(swapBits(byte(value + 0xce)) + 0x9a) ^ 0x11, 0xffffffff, 0);
  }
  if (reader.offset !== data.length) throw new RangeError('Trailing bytes in hero spawn');
  const name = model.toString('latin1');
  return id && /^[A-Za-z][A-Za-z0-9_]*$/.test(name) ? { id, model: name } : null;
}

// Type 664 carries a hero's end-of-game stat block. The playing client gets it
// only when the hero spawns, so its totals are zero. Spectator keyframes carry
// the same packet for every hero with current totals. There the object ID is
// the block parameter instead of the first field. The deserializer at
// 0x1010474c0 writes the vector in alternating front/back order.
export const HERO_STATS_PACKET = 664;
const HERO_STATS_BYTES = 1260;
const heroStatsTable = Buffer.from('030bf2fae2ead2da434b333b232b131b828a727a626a525ac2cab2baa2aa929a020af1f9e1e9d1d9424a323a222a121a8189717961695159c1c9b1b9a1a99199050df4fce4ecd4dc454d353d252d151d848c747c646c545cc4ccb4bca4ac949c040cf3fbe3ebd3db444c343c242c141c838b737b636b535bc3cbb3bba3ab939b070ff6fee6eed6de474f373f272f171f868e767e666e565ec6ceb6bea6ae969e060ef5fde5edd5dd464e363e262e161e858d757d656d555dc5cdb5bda5ad959d0109f0f8e0e8d0d841493139212911198088707860685058c0c8b0b8a0a890980008f7ffe7efd7df4048303820281018878f777f676f575fc7cfb7bfa7af979f', 'hex');
const decodeHeroStatsByte = (value) => heroStatsTable[value];
function readHeroStatVector(reader) {
  const flags = reader.next();
  // The client reads the length and vector only for these selector values.
  if (![0, 1, 2, 4].includes(flags & 15)) return null;
  const size = reader.varint(decodeHeroStatsByte, 0x7000);
  const encoded = reader.vector(size);
  if (reader.offset !== reader.data.length) throw new RangeError('Trailing bytes in hero stats');
  if (size !== HERO_STATS_BYTES) return null;
  const vector = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) vector[i % 2 ? size - 1 - (i >>> 1) : i >>> 1] = decodeHeroStatsByte(encoded[i]);
  return vector;
}

// Spectator form: the block parameter holds the hero ID.
export function decodeHeroStatSnapshot(data) {
  if (!(data instanceof Uint8Array) || !data.length || data.length >= 0x7000) throw new RangeError('Invalid hero stats size');
  return heroStatFields(readHeroStatVector(new PacketReader(data)));
}

// Playing-client form, with the hero ID as the first field.
export function decodeLiveHeroStatSnapshot(data) {
  if (!(data instanceof Uint8Array) || !data.length || data.length >= 0x7000) throw new RangeError('Invalid hero stats size');
  const reader = new PacketReader(data);
  const id = readOwner(reader);
  const stats = heroStatFields(readHeroStatVector(reader));
  return stats && { id, ...stats };
}

// Type 1045 carries a vector of packet lengths and an encoded vector of bytes.
const decodeBatchLength = (value) => netIdTable[swapBits(rotateLeft(value, 4))] ^ 0x1e;
function decodeBatchByte(value) {
  const swapped = swapBits(byte(value + 13) ^ 0xf1) ^ 0x24;
  return byte(((swapped + 0x33) ^ 0x96) + 4);
}

export function decodeDamageBatch(data) {
  const reader = new PacketReader(data);
  readOwner(reader);
  const mask = reader.next();
  const count = mask & 1 ? reader.varint(decodeBatchLength, 4096, 0) : 0;
  const lengths = Array.from({ length: count }, () => reader.varint(decodeBatchLength, 0xffff, 0));
  const size = mask & 2 ? reader.varint(decodeBatchByte, 0x7000) : 0;
  const vector = reader.vector(size);
  if (reader.offset !== data.length || lengths.some((length) => length === 0) ||
      lengths.reduce((total, length) => total + length, 0) !== size) {
    throw new RangeError('Invalid damage batch boundaries');
  }
  const packets = [];
  let offset = 0;
  const decoded = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) {
    const destination = i % 2 ? size - 1 - (i >>> 1) : i >>> 1;
    decoded[destination] = decodeBatchByte(vector[i]);
  }
  // The length array is serialized in the same alternating front/back order.
  const ordered = Array(count);
  lengths.forEach((length, i) => { ordered[i % 2 ? count - 1 - (i >>> 1) : i >>> 1] = length; });
  for (const length of ordered) {
    packets.push(decoded.subarray(offset, offset + length));
    offset += length;
  }
  return packets;
}

// Type 393 drives the floating combat text. Follow the client's deserializer
// at 0x10101f110 and the fields its consumer at 0x1000e1490 reads. After the
// owner it holds four selector bytes, then the amount, hash, source, target,
// type, display, two fields the consumer does not report, and the result.
// Its varints OR in 7-bit digits with the shift taken modulo 32, as the client
// does, and have no length limit. ID fields flip 0x40000000 like the owner.
const displayAmountByte = (value) => rotateLeft(netIdTable[value] ^ 0x57, 1);
const displayHashByte = (value) => rotateLeft(byte(~rotateLeft(netIdTable[value], 2)), 6);
const displaySourceByte = (value) => swapBits(byte(swapBits(netIdTable[rotateLeft(swapBits(value), 4)]) + 0x28));
const displayTargetByte = (value) => rotateLeft(netIdTable[netIdTable[swapBits(value)]], 3);
const displayUnusedIdByte = (value) => rotateLeft(swapBits(value ^ 0x37) ^ 0xa3, 3);
const displayTypeByte = (value) => byte(~(netIdTable[byte(netIdTable[value] + 0xdc)] + 0xf5));
const displayCodeByte = (value) => netIdTable[byte((byte(rotateLeft(value, 2) + 0x0f) ^ 0x91) + 0xa8) ^ 0x32] ^ 0x45;
const displayResultByte = (value) => netIdTable[byte((value ^ 0x9e) + 0x68) ^ 0xb7];

// Selector cases without a wire field store these constants, encoded as the
// object stores the field. The consumer decodes them byte by byte.
const displayWord = (encoded, transform) => {
  const raw = Buffer.alloc(4);
  raw.writeUInt32LE(encoded);
  return Buffer.from(raw.map(transform));
};
const displayAmountDefaults = Object.fromEntries([[2, 0x53678585], [4, 0xf9858585], [6, 0xbb678585], [7, 0x85858585]]
  .map(([field, encoded]) => [field, displayWord(encoded, displayAmountByte).readFloatLE()]));
const displayHashDefaults = Object.fromEntries([[1, 0xd8d8d86a], [4, 0xd8d8d8c1], [5, 0xd8d8d8d8], [6, 0x3e3e3e3e]]
  .map(([field, encoded]) => [field, displayWord(encoded, displayHashByte).readUInt32LE()]));
const displaySourceDefaults = { 4: displayWord(0x74747474, displaySourceByte).readUInt32LE(),
  7: displayWord(0x68686868, displaySourceByte).readUInt32LE() };
const displayTargetDefaults = { 4: displayWord(0xdcdcdcdc, displayTargetByte).readUInt32LE(),
  7: displayWord(0xf9f9f9f9, displayTargetByte).readUInt32LE() };
const displayTypeDefaults = { 3: displayTypeByte(0x7c), 4: displayTypeByte(0x33), 5: displayTypeByte(9), 7: displayTypeByte(0x0e) };
const displayCodeDefaults = { 0: displayCodeByte(0x55), 1: displayCodeByte(0x67), 2: displayCodeByte(0xaf), 4: displayCodeByte(0xc1) };
const displayResultDefaults = { 0: displayResultByte(0xbf), 3: displayResultByte(0x62), 4: displayResultByte(0x99),
  7: displayResultByte(0xd4) };

export const DAMAGE_DISPLAY_PACKET = 393;

// Takes the playing-client form, with the owner as the first field.
export function decodeDamageDisplay(data) {
  if (!(data instanceof Uint8Array) || !data.length || data.length >= 0x7000) {
    throw new RangeError('Invalid damage display size');
  }
  const reader = new PacketReader(data);
  readDisplayVarint(reader, decodeNetId, true);
  return readDamageDisplayFields(reader);
}

// Spectator blocks hold the owner in the block parameter instead. The
// consumer does not use the owner, so only the fields after it are read.
export function decodeSpectatorDamageDisplay(_ownerId, payload) {
  if (!(payload instanceof Uint8Array) || !payload.length || payload.length >= 0x7000) {
    throw new RangeError('Invalid damage display size');
  }
  return readDamageDisplayFields(new PacketReader(payload));
}

function readDamageDisplayFields(reader) {
  const data = reader.data;
  const [first, second, third, fourth] = reader.vector(4);
  const field = (defaults, selector, read) => defaults[selector] ?? read();

  const amount = field(displayAmountDefaults, second >>> 4 & 7,
    () => Buffer.from(reader.vector(4)).map(displayAmountByte).readFloatBE());
  const hash = field(displayHashDefaults, (first >>> 6) + (second & 1) * 4,
    () => readDisplayVarint(reader, displayHashByte, false));
  const sourceId = field(displaySourceDefaults, (second >>> 7) + (third & 3) * 2,
    () => readDisplayVarint(reader, displaySourceByte, true));
  // The low bit of the fourth selector is a flag stored without a wire field.
  const targetId = field(displayTargetDefaults, fourth >>> 1 & 7,
    () => readDisplayVarint(reader, displayTargetByte, true));
  const typeCode = field(displayTypeDefaults, first & 7, () => displayTypeByte(reader.next()));
  const displayCode = field(displayCodeDefaults, third >>> 2 & 7, () => displayCodeByte(reader.next()));
  // An ID and a fixed four-byte value the consumer does not report.
  if (![4, 6].includes(third >>> 5)) readDisplayVarint(reader, displayUnusedIdByte, true);
  if ([1, 3, 4, 7].includes(first >>> 3 & 7)) reader.vector(4);
  const resultCode = field(displayResultDefaults, second >>> 1 & 7, () => displayResultByte(reader.next()));

  if (reader.offset !== data.length) throw new RangeError('Trailing bytes in damage display');
  // Reject amounts that are not finite or are negative, as the research
  // oracle does. Amount selector 2 always stores -1.
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError('Invalid damage display amount');
  return { sourceId, targetId, amount, typeCode, resultCode, displayCode, hash };
}

// Type 979 marks a champion as having dealt or taken damage at a server
// time. Attacker and target get the same time. The low selector tells a hit
// between champions (0) from one involving a minion, monster or structure
// (3). The deserializer at vtable slot 1 decodes the time with this table.
const combatMarkerTimeTable = Buffer.from('85051e92c657fe28fbf3c4d838f9d94f250b678fb6225ab3c0210953f4f61c7f7d35f7be3e867ba662c97e4d808b290ec3bacfa8e794618e407ab51f69703cfa713d996ca4ddcd9fb159a052bd089bb789e1e92caf01e5518df26046a1ed969549ad3706e6cc4400172d7783f1d19158a7b0bcd424ef14a32710fc2b343a72d03b42c7cab84ecbf00cdae38c03c233d656e85c6619e473e2840a78de166a979dc19edf3fab4aac48d56beac579114bffaa9ca50d040f2f2a9a45fd1b64d754b22602134787a2555e986f75bfae15ce205f4cb923507c31b49043eb88ec65f53674e0c8121d686da93293812e5b078a1863eebb5d301ad2826e76d3dc41dbf839', 'hex');

export function decodeCombatMarker(data) {
  const reader = new PacketReader(data);
  const owner = readOwner(reader);
  const flags = reader.next();
  const kind = flags & 7;
  if (![3, 5, 6, 7].includes(flags >>> 3 & 7) || (kind !== 0 && kind !== 3)) return null;
  const time = Buffer.from(reader.vector(4)).map((value) => combatMarkerTimeTable[value]).readFloatLE();
  if (reader.offset !== data.length) throw new RangeError('Trailing bytes in combat marker');
  return owner && Number.isFinite(time) && time >= 0 ? { owner, time, champion: kind === 0 } : null;
}

// Type 952 carries unit replication records behind the server time of the
// tick. The vector reader at 0x1010ef160 writes alternating front and back
// bytes.
const decodeReplicationByte = (value) => netIdTable[netIdTable[value]] ^ 0x13;
const decodeReplicationHeader = (value) => byte(swapBits(rotateLeft(swapBits(value), 5)) + 0xaa) ^ 0x6d;
const replicationTimeTable = Buffer.from('08e926c266876b37b7978ba0d36810dbebaa330386a12ce379a2f7aeb383848838853fa83935b636aff99309eebad74c1749fd1d1b506e19bd8f7470d0ef4705faf4d8de2511f80244bc926cf107fb6a4d15e6211cea5efedce5322e485dbf4e1ac52a8ce758f5b0c49b63420422ff898d7e523ef38a2457205a91ddf0e1ce64a4cd5cc1cae095064a29e4b1d9949a3b73abc04b7690b977a7cc6d31010cc327d27aac0ddacb72d47be2c65f0e3adf652840785bf62bbb9d69cf7f1f2db41867c914e8c7d6a3b241b5540a9ebe4f7512ed8e3d965981fcecadb8518023617d455643711e130f823c2f0b9cc860627cd1a5d530a99900469855f26f9f533416a6', 'hex');

export function decodeReplication(data) {
  const reader = new PacketReader(data);
  readOwner(reader);
  const [first, second] = reader.vector(2);
  const time = [0, 1, 4, 5].includes(first >>> 1 & 7)
    ? Buffer.from(reader.vector(4)).map((value) => replicationTimeTable[value]).readFloatBE() : null;
  if ([0, 1, 2, 4].includes((first >>> 7) + (second & 3) * 2)) {
    reader.varint(decodeReplicationHeader, 0xffffffff, 0);
  }
  if ([0, 1, 3, 6].includes(first >>> 4 & 7)) reader.next();
  const size = first & 1 ? 0 : reader.varint(decodeReplicationByte, 0x7000);
  const encoded = reader.vector(size);
  if (reader.offset !== data.length) throw new RangeError('Trailing bytes in replication');
  return { time: Number.isFinite(time) && time >= 0 ? time : null, vector: unfoldReplicationVector(encoded, decodeReplicationByte) };
}
