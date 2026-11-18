import { byte, netIdTable, PacketReader, readDisplayVarint, readOwner, rotateLeft, swapBits } from './livePacketReader.js';
import { decodeCombatBody } from './damageCombatBody.js';
import { heroStatFields } from './heroStats.js';
import { unfoldReplicationVector } from './liveReplication.js';

// Verified against the macOS deserializers for 16.23.8396405 and an EUW
// playing-client capture. The common object ID and decoded stat layouts
// are shared with 16.22, but the envelope selectors and byte order changed.
const combatBodyByte = (value) => netIdTable[byte(rotateLeft(byte(0x16 - netIdTable[swapBits(value)]), 3) + 0x34)];
const combatKindByte = (value) => byte(rotateLeft(rotateLeft(value, 4) ^ 255, 6) + 0x0e);
const combatSchemaByte = (value) => netIdTable[swapBits(rotateLeft(byte((value ^ 0x70) + 0x0a), 7)) ^ 255];
const kinds = [0, 65535, 2, 1, null, null, null, null];
const schemas = [2, 0, 1, null, null, null, null, 0xffffffff];

export function decodeCombatEvent(data) {
  if (!(data instanceof Uint8Array) || !data.length || data.length >= 0x7000) {
    throw new RangeError('Invalid damage event envelope size');
  }
  const reader = new PacketReader(data);
  const owner = readOwner(reader);
  const flags = reader.next();
  const kind = kinds[flags & 7] ?? reader.varint(combatKindByte, 0xffff);
  const vector = reader.vector(flags & 8 ? reader.varint(combatBodyByte, 0x7000) : 0);
  const schema = schemas[flags >>> 4 & 7] ?? reader.varint(combatSchemaByte, 0xffffffff);
  if (reader.offset !== data.length) throw new RangeError('Trailing bytes in damage event envelope');
  return decodeCombatBody(owner, schema, kind, vector, combatBodyByte);
}

const heroStatByte = (value) => netIdTable[rotateLeft(byte(0x91 - value) ^ 0xd4, 1)] ^ 0x7f;

export function decodeHeroStatVector(data) {
  if (!(data instanceof Uint8Array) || data.length !== 1263) return null;
  const reader = new PacketReader(data);
  const flags = reader.next();
  if ((flags & 8) || ![1, 2, 5, 6].includes(flags & 7)) return null;
  const size = reader.varint(heroStatByte, 0x7000);
  if (size !== 1260) return null;
  const encoded = reader.vector(size);
  if (reader.offset !== data.length) throw new RangeError('Trailing bytes in hero stats');
  const vector = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) vector[size - i - 1] = heroStatByte(encoded[i]);
  return vector;
}

export function decodeHeroStatSnapshot(data) {
  return heroStatFields(decodeHeroStatVector(data));
}

const batchLengthByte = (value) => rotateLeft(byte((value ^ 0x40) + 0xb6) ^ 0xb0, 3) ^ 0x5e;
const batchBodyByte = (value) => rotateLeft(byte(netIdTable[netIdTable[rotateLeft(byte(value + 0x1d), 7)]] + 0x5e), 3);

export function decodeDamageBatch(data) {
  const reader = new PacketReader(data);
  readOwner(reader);
  const flags = reader.next();
  const count = flags & 1 ? reader.varint(batchLengthByte, 4096, 0) : 0;
  const lengths = Array.from({ length: count }, () => reader.varint(batchLengthByte, 0xffff, 0));
  const size = flags & 2 ? reader.varint(batchBodyByte, 0x7000) : 0;
  const body = Buffer.from(reader.vector(size)).map(batchBodyByte);
  if (reader.offset !== data.length || lengths.some((length) => !length) ||
      lengths.reduce((sum, length) => sum + length, 0) !== size) {
    throw new RangeError('Invalid damage batch boundaries');
  }
  let offset = 0;
  return lengths.map((length) => {
    const start = offset;
    offset += length;
    return body.subarray(start, offset);
  });
}

// Type 530 floating damage row. The target and source IDs are the first
// and third variable-width object fields in the four-selector envelope.
const displayAmountByte = (value) => netIdTable[rotateLeft(byte(netIdTable[value ^ 5] + 0xa7), 3)] ^ 0x22;
const displaySchoolByte = (value) => rotateLeft(rotateLeft(byte(0x3b - value), 3) ^ 255, 4) ^ 255;
const displayTargetByte = (value) => rotateLeft(netIdTable[byte((rotateLeft(swapBits(rotateLeft(value, 1)) ^ 255, 6) ^ 0x82) + 0x37)], 6);
const displayUnusedIdByte = (value) => rotateLeft(byte(0xdb - swapBits(value)), 1);
const displaySourceByte = (value) => rotateLeft(netIdTable[netIdTable[value ^ 0x24] ^ 0xf2] ^ 0xb0, 1);
const displayHashByte = (value) => rotateLeft(swapBits(netIdTable[byte(5 - netIdTable[value])]) ^ 0x5b, 3);

function decodeWord(value, transform) {
  const raw = Buffer.alloc(4);
  raw.writeUInt32LE(value);
  return raw.map(transform);
}

const amountDefaults = [null, 0x718e8e8e, null, 0xb0908e8e, null, 0x3d908e8e, null, 0x8e8e8e8e]
  .map((value) => value == null ? null : decodeWord(value, displayAmountByte).readFloatLE());
const schoolDefaults = [null, null, 0x39, 0x3b, 0x3c, null, 0x37, null]
  .map((value) => value == null ? null : displaySchoolByte(value));
const targetDefaults = { 1: decodeWord(0x6b6b6b6b, displayTargetByte).readUInt32LE(),
  2: decodeWord(0xd9d9d9d9, displayTargetByte).readUInt32LE() };
const sourceDefaults = { 0: decodeWord(0x98989898, displaySourceByte).readUInt32LE(),
  5: decodeWord(0x83838383, displaySourceByte).readUInt32LE() };

export function decodeSpectatorDamageDisplay(_owner, payload) {
  const reader = new PacketReader(payload);
  const [first, second, third, fourth] = reader.vector(4);
  const amount = amountDefaults[first >>> 3 & 7] ??
    Buffer.from(reader.vector(4)).map(displayAmountByte).readFloatLE();
  const typeCode = schoolDefaults[(first >>> 6) + (second & 1) * 4] ?? displaySchoolByte(reader.next());
  if ([0, 1, 4, 6].includes((second >>> 7) + (third & 3) * 2)) reader.next();
  const targetId = targetDefaults[fourth & 7] ?? readDisplayVarint(reader, displayTargetByte, true);
  if ([0, 4, 6, 7].includes(third >>> 5)) reader.vector(4);
  if ([1, 2, 5, 6].includes(second >>> 1 & 7)) reader.next();
  if (![2, 7].includes(second >>> 4 & 7)) readDisplayVarint(reader, displayUnusedIdByte, true);
  const sourceId = sourceDefaults[first & 7] ?? readDisplayVarint(reader, displaySourceByte, true);
  if ([1, 2, 4, 7].includes(third >>> 2 & 7)) readDisplayVarint(reader, displayHashByte, false);
  if (reader.offset !== payload.length) throw new RangeError('Trailing bytes in damage display');
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError('Invalid damage display amount');
  return { sourceId, targetId, amount, typeCode };
}

const recapObjectIdByte = (value) => byte((rotateLeft(value ^ 255, 2) ^ 0xf1) + 0xfa) ^ 0x8a;
const spawnUnusedWordByte = (value) => rotateLeft(byte(swapBits(netIdTable[rotateLeft(value ^ 0x61, 3)]) + 0x68) ^ 0x18, 3);
const modelBytes = [
  null,
  (value) => netIdTable[byte(netIdTable[byte(rotateLeft(value ^ 255, 6) + 0x49)] + 0xc1)],
  (value) => rotateLeft(byte(value + 0xfc), 2) ^ 0x21,
  (value) => byte(swapBits(netIdTable[byte(value + 0x82)]) + 0x13)
];
const displayNameBytes = [
  (value) => byte(netIdTable[swapBits(rotateLeft(value, 7))] + 0xe7),
  (value) => byte(rotateLeft(netIdTable[swapBits(byte(rotateLeft(value, 2) + 0xfc))] ^ 255, 7) + 0xe1),
  null,
  (value) => rotateLeft(netIdTable[byte((rotateLeft(byte((value ^ 0xb0) + 0x48), 4) ^ 0x68) + 0xda)], 5)
];

// Type 88 identifies the spawned hero and model, including Practice Tool
// dummies. Advance through the selected fields to the model string.
export function decodeDamageHeroSpawn(data, { spectator = false } = {}) {
  if (!(data instanceof Uint8Array) || !data.length || data.length >= 0x7000) {
    throw new RangeError('Invalid hero spawn size');
  }
  const reader = new PacketReader(data);
  if (!spectator) readOwner(reader);
  const [first, second, third, fourth, fifth, sixth] = reader.vector(6);
  if ([3, 4, 6, 7].includes(second >>> 4 & 7)) reader.next();
  if (third & 4) reader.vector(12);
  if ([1, 2, 3, 5].includes(second >>> 1 & 7)) reader.next();
  if (sixth & 0x10) reader.next();
  if ([1, 5, 6, 7].includes(first >>> 3 & 7)) reader.next();
  if ([0, 1, 3, 6].includes(fifth >>> 4 & 7)) reader.vector(4);
  if ([3, 5, 6, 7].includes((first >>> 6) + (second & 1) * 4)) reader.vector(4);
  if ([3, 4, 5, 6].includes(third >>> 4 & 7)) reader.vector(4);
  if ([1, 2, 5, 7].includes((fifth >>> 7) + (sixth & 3) * 2)) {
    reader.varint(spawnUnusedWordByte, 0xffffffff);
  }
  if ([0, 2, 3, 6].includes((second >>> 7) + (third & 3) * 2)) reader.next();
  const modelEncoding = sixth >>> 2 & 3;
  const transform = modelBytes[modelEncoding];
  const encoded = transform ? reader.vector(reader.varint(transform, 128, modelEncoding === 2 ? 0 : 128)) : [];
  const model = Buffer.alloc(encoded.length);
  for (let i = 0; i < encoded.length; i++) {
    const position = modelEncoding !== 3 ? i
      : (i & 1) ? encoded.length - 1 - (i >>> 1) : i >>> 1;
    model[position] = transform(encoded[i]) ^ (modelEncoding === 2 ? 0x80 : 0);
  }
  if ([0, 4, 6, 7].includes((third >>> 7) + (fourth & 3) * 2)) reader.next();
  const idField = fourth >>> 4 & 7;
  const idValue = idField === 2 || idField === 6 ? 0 : reader.varint(recapObjectIdByte, 0xffffffff);
  const id = ((idValue & 0xffffff) ? idValue ^ 0x40000000 : idValue) >>> 0;
  if ([2, 3, 5, 6].includes(first & 7)) reader.next();

  const nameDecoder = displayNameBytes[fourth >>> 2 & 3];
  if (nameDecoder) reader.vector(reader.varint(nameDecoder, 0x7000));
  if (!(sixth & 0x20)) reader.next();
  if (!(sixth & 0x40)) reader.vector(12);
  if (reader.offset !== data.length) throw new RangeError('Trailing bytes in hero spawn');
  const name = model.toString('latin1');
  return id && /^[A-Za-z][A-Za-z0-9_]*$/.test(name) ? { id, model: name } : null;
}

const recapDurationByte = (value) => swapBits(rotateLeft(netIdTable[byte(value + 0x15)], 5));
const recapEntryCountByte = (value) => rotateLeft(byte(swapBits(rotateLeft(value, 7)) + 0xd4), 6);
const recapDetailCountByte = (value) => byte(value + 0x89) ^ 0x20;
const recapEntryNameBytes = [
  (value) => rotateLeft(byte(rotateLeft(netIdTable[rotateLeft(value, 2) ^ 255], 4) + 2), 5),
  (value) => byte(0xd1 - swapBits(byte(0xae - value))) ^ 0x4b,
  (value) => swapBits(rotateLeft(byte(swapBits(netIdTable[byte(value + 0x77)]) + 0xf0), 3))
];
const recapPhysicalByte = (value) => byte(rotateLeft(byte(value + 0x88), 2) + 0x80);
const recapMagicByte = (value) => netIdTable[swapBits(netIdTable[value ^ 0x67] ^ 0x3b)];
const recapTrueByte = (value) => rotateLeft(swapBits(byte((value ^ 0xbf) + 0x7e)) ^ 0x1f, 5);
const recapDetailIndexByte = (value) => byte(swapBits(netIdTable[byte(netIdTable[value] + 0xdf)]) + 0xe9);
const recapDetailTimeByte = (value) => byte(rotateLeft(rotateLeft(value ^ 255, 7) ^ 0xdc, 7) + 0x56);
const recapPhysicalDefaults = [null, 0x67789898, 0x98989898, 0x47789898, null, 0xa8989898];
const recapMagicDefaults = [0x89bcdada, 0xcbdadada, null, null, 0xd6bcdada, null, null, 0xdadadada];
const recapTrueDefaults = [null, 0x0e0e0e0e, null, 0xec160e0e, null, 0xe4160e0e, 0x0f0e0e0e];
const recapDurationDefaults = [0xaef02929, null, 0x29292929, null, null, 0xf4292929, 0x6bf02929];

function recapFloat(reader, encodedDefault, transform, littleEndian = false) {
  if (encodedDefault != null) return decodeWord(encodedDefault, transform).readFloatLE();
  const decoded = Buffer.from(reader.vector(4)).map(transform);
  return littleEndian ? decoded.readFloatLE() : decoded.readFloatBE();
}

function readRecapDetail(reader, outgoing) {
  const [first, second, third] = reader.vector(3);
  const physical = recapFloat(reader, recapPhysicalDefaults[first >>> 3 & 7], recapPhysicalByte);
  const magic = recapFloat(reader, recapMagicDefaults[first & 7], recapMagicByte);
  if ([0, 1, 2, 6].includes((first >>> 6) + (second & 1) * 4)) reader.varint(recapDetailIndexByte, 0xffffffff);
  if ([0, 1, 2, 7].includes((second >>> 6) + (third & 1) * 4)) reader.varint(recapDetailTimeByte, 0xffffffff);
  const trueDamage = recapFloat(reader, recapTrueDefaults[second >>> 2 & 7], recapTrueByte);
  if (!outgoing) return;
  for (const [school, amount] of Object.entries({ physical, magic, true: trueDamage })) {
    if (!Number.isFinite(amount) || amount < 0) {
      outgoing.valid = false;
      continue;
    }
    outgoing.schools[school] += amount;
    outgoing.displayTypes[school] += Math.ceil(amount);
  }
}

function readRecapEntry(reader, outgoing) {
  const flags = reader.next();
  const transform = recapEntryNameBytes[flags & 3];
  if (transform) reader.vector(reader.varint(transform, 0x7000));
  if (!(flags & 4)) {
    const count = reader.varint(recapDetailCountByte, 0x7000, 0);
    for (let i = 0; i < count; i++) readRecapDetail(reader, outgoing);
  }
  if (![2, 6].includes(flags >>> 3 & 7)) reader.varint(recapObjectIdByte, 0xffffffff);
}

// Type 502 supplies the fight duration and final outgoing damage entry.
export function decodeDeathRecap(data) {
  if (!(data instanceof Uint8Array) || !data.length || data.length >= 0x7000) {
    throw new RangeError('Invalid death recap size');
  }
  const reader = new PacketReader(data);
  readOwner(reader);
  const [first, second, third] = reader.vector(3);
  if (third & 1) {
    const count = reader.varint(recapEntryCountByte, 0x7000);
    for (let i = 0; i < count; i++) readRecapEntry(reader);
  }
  if ([0, 2, 3, 5].includes((first >>> 6) + (second & 1) * 4)) reader.vector(4);
  const duration = recapFloat(reader, recapDurationDefaults[second >>> 1 & 7], recapDurationByte, true);
  const idField = second >>> 4 & 7;
  if (idField !== 2 && idField !== 6) reader.varint(recapObjectIdByte, 0xffffffff);
  if ([0, 1, 2, 7].includes(first >>> 3 & 7)) reader.vector(4);
  const schools = { physical: 0, magic: 0, true: 0 };
  const outgoing = { schools, displayTypes: { ...schools }, valid: true };
  if (second & 0x80) readRecapEntry(reader, outgoing);
  if ([1, 3, 5, 7].includes(first & 7)) reader.vector(4);
  if (reader.offset !== data.length || !Number.isFinite(duration)) throw new RangeError('Invalid death recap fields');
  return { duration: duration >= 0 ? duration : null, schools: outgoing.valid ? schools : null,
    displayTypes: outgoing.valid ? outgoing.displayTypes : null };
}

// Type 503 marks a champion as having dealt or taken damage at a server
// time. Attacker and target get the same time. The middle selector tells a
// hit between champions from one involving a minion, monster or structure.
// The deserializer decodes the time with this table before storing it.
const combatMarkerTimeTable = Buffer.from('e93fdb31e6bf12da447d32e3d6cb170f20069dd78df2038c0edc6c210dc9fd07fbd20080399ed5b1427f5072f86d65bb7330ffade7d366bd435a61a94b97f72f48f18e60b671efd9f36937fc4f3d47a5a42c5e5faf4e99b411014af683bc2d14773b7acf9a239863a7227ce1c336d81a6e93f557e2b2f4b8de7e3338fee890340b262bae092e1ef0185b593a3c2ae488dd1f292545b776f94dce70b57964b98495ac191c9168c205a8e50c947b6b025c9b9fc1ee10151d8bd4785254d0756a27ec81cca30874a186eafa8a041bba6fd1eb0a3ec053a0c8ed8f13568982a2a65d4c8758c78551c69cc4becac528cd35249655416267b3dfb0aa92ab164649e040', 'hex');
const MARKER_CHAMPION = 7;
const MARKER_UNIT = 3;

export function decodeCombatMarker(data) {
  const reader = new PacketReader(data);
  const owner = readOwner(reader);
  const flags = reader.next();
  const kind = flags >>> 3 & 7;
  if (![0, 1, 4, 6].includes(flags & 7) || (kind !== MARKER_CHAMPION && kind !== MARKER_UNIT)) return null;
  const time = Buffer.from(reader.vector(4)).map((value) => combatMarkerTimeTable[value]).readFloatBE();
  if (reader.offset !== data.length) throw new RangeError('Trailing bytes in combat marker');
  return owner && Number.isFinite(time) && time >= 0 ? { owner, time, champion: kind === MARKER_CHAMPION } : null;
}

// Type 309 carries unit replication records behind the server time of the
// tick. A one-byte field and a counter follow the vector. The selectors
// and both byte tables come from the pinned deserializer: every flag value
// was probed, and 5,543 captured packets decoded without a conflict.
const replicationTable = Buffer.from('5cd2cf752fac7744061db330497e99cc3db1c73a73fa37f7d7b9874163489bef96946e55a8b72b1197e3711a408688213be60f473ffddadec1ae280c0393a4d5be0059fe36db683c4b9012df45e8342238468416a99a35e7ecfc4fff14bf085b98dd29f52ca242c302f8e2f17478ee10578ece64b6527d19f47666b58bc4a6926170b226f250c0f3c8601c796d8cab62a3d49caf4aaa65eb18d62e0ba1d36c859fbbb0e40dbaf9a505c6ea51e92a15955a33e5586b1725bd89040191a0e180fb2713c2ca435623a7815467b41e695e9d0a399e535d8dd05f097bcb8324edb8ad7ac5820e4d32314c1b8f07d9dcf0bc4e20d1c9d8f62d728ae03e7f6a1f6fcd7c', 'hex');
const decodeReplicationByte = (value) => replicationTable[value];
const replicationTimeByte = (value) => byte(value + 0x82);
const REPLICATION_TRAILER_BYTES = 6;

export function decodeReplication(data) {
  const reader = new PacketReader(data);
  readOwner(reader);
  const [first, second] = reader.vector(2);
  const time = first & 8 ? Buffer.from(reader.vector(4)).map(replicationTimeByte).readFloatLE() : null;
  const size = first & 1 ? 0 : reader.varint(decodeReplicationByte, 0x7000);
  const encoded = reader.vector(size);
  if ([1, 2, 4, 7].includes((first >>> 7) + (second & 3) * 2)) reader.next();
  // The counter is the last field, so its own length needs no decoding.
  const counter = data.length - reader.offset;
  if ([0, 4, 5, 6].includes(first >>> 4 & 7) ? counter < 1 || counter > REPLICATION_TRAILER_BYTES - 1 : counter !== 0) {
    throw new RangeError('Unexpected replication trailer');
  }
  return { time: Number.isFinite(time) && time >= 0 ? time : null, vector: unfoldReplicationVector(encoded, decodeReplicationByte) };
}
