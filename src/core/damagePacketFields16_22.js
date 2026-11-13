// Standalone application-packet parser for the type 743 envelope on 16.22.8348910.
// The caller must verify the build and transport checksum before decoding.
// Table offsets in the pinned macOS client are 0x10212c610 and 0x10210e200.
const netIdTable = Buffer.from('d75682dc83028f2935042171799e927fcb976a5105c76fe640637e345b4707785a96b8b92c995e6ed1754161245f4aaa4bcf0ed4865dba1d3f2bdf62f0330055cafc19acf3662369bceb46f89c50874d6d108e88be1bb5da4e1a13cc2209ada49d30a6e57dfac91712c2fde1bbe70b98bfbd1137c07cf795b6dd49f4812a9f1cfb8d9a727b577a43b3a953e459202fa8f67436a085f1a7147031840cb2a5dbe816ae3d25b1cd9b0367155cea1f39a1440a8b76de606593f264d5c1c84c064fb7edfee0f9a2184891ce1e3cb46c425494e328e90127ec0d45ff26efe28aabd9f508c4af32c56b80c6c358eea33e2d0f893ab0d2d33873d8d08c7790523bd62e68', 'hex');
const eventTable = Buffer.from('d75682dc83028f2935042171799e927fcb976a5105c76fe640637e345b4707785a96b8b92c995e6ed1754161245f4aaa4bcf0ed4865dba1d3f2bdf62f0330055cafc19acf3662369bceb46f89c50874d6d108e88be1bb5da4e1a13cc2209ada49d30a6e57dfac91712c2fde1bbe70b98bfbd1137c07cf795b6dd49f4812a9f1cfb8d9a727b577a43b3a953e459202fa8f67436a085f1a7147031840cb2a5dbe816ae3d25b1cd9b0367155cea1f39a1440a8b76de606593f264d5c1c84c064fb7edfee0f9a2184891ce1e3cb46c425494e328e90127ec0d45ff26efe28aabd9f508c4af32c56b80c6c358eea33e2d0f893ab0d2d33873d8d08c7790523bd62e68', 'hex');
const DAMAGE_SCHEMA = 0x2839cc82;
const DAMAGE_EVENT_BYTES = 96;
const schemaDefaults = [1, 0xffffffff, 0, null, 2, null, null, null];
const kindDefaults = [null, null, 0, 2, 65535, null, 1, null];

const byte = (value) => value & 255;
const rotateLeft = (value, count) => byte(value << count | value >>> (8 - count));
const swapBits = (value) => (value >>> 1 & 0x55) | (value << 1 & 0xaa);
const decodeNetId = (value) => netIdTable[byte(netIdTable[rotateLeft(byte(netIdTable[value ^ 255] + 0x54), 1)] + 0xb4)];
const decodeLength = (value) => rotateLeft(byte(rotateLeft(byte(value + 0x62), 2) + 0x82), 4);
const decodeSchema = (value) => byte((rotateLeft(eventTable[byte(eventTable[value] + 0x51)], 7) ^ 0x5f) + 0xfc);
const decodeKind = (value) => swapBits(byte(~rotateLeft(eventTable[value], 7)));

class PacketReader {
  constructor(data) { this.data = data; this.offset = 0; }
  next() {
    if (this.offset >= this.data.length) throw new RangeError('Truncated damage event envelope');
    return this.data[this.offset++];
  }
  varint(transform, max, continuation = 128) {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const digit = transform(this.next());
      value += (digit & 127) * 2 ** shift;
      if (value > max) break;
      if ((digit & 128) !== continuation) return value;
    }
    throw new RangeError('Damage event varint exceeds its field width');
  }
  vector(size) {
    if (size > this.data.length - this.offset) throw new RangeError('Truncated damage event vector');
    const result = this.data.subarray(this.offset, this.offset + size);
    this.offset += size;
    return result;
  }
}

export function decodeDamageStatEvent(data) {
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
  if (schema !== DAMAGE_SCHEMA || ![24, 25].includes(kind)) return null;
  if (size !== DAMAGE_EVENT_BYTES) throw new RangeError('Unexpected damage event body size');

  const body = Buffer.alloc(DAMAGE_EVENT_BYTES);
  for (let i = 0; i < size; i++) body[size - i - 1] = decodeLength(vector[i]);
  const peer = body.readUInt32LE(4);
  const schools = { physical: body.readFloatLE(28), magic: body.readFloatLE(32), true: body.readFloatLE(36) };
  const extraAmount = body.readFloatLE(40);
  if (!owner || !peer || [...Object.values(schools), extraAmount].some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError('Invalid damage event fields');
  }
  return {
    candidateSourceNetId: kind === 25 ? owner : peer,
    candidateTargetNetId: kind === 25 ? peer : owner,
    candidateAmount: schools.physical + schools.magic + schools.true,
    schools,
    extraAmount,
    candidateHash: body.readUInt32LE(80),
    statDirection: kind === 25 ? 'outgoing' : 'incoming'
  };
}

function readOwner(reader) {
  const value = reader.varint(decodeNetId, 0xffffffff);
  return ((value & 0xffffff) ? value ^ 0x40000000 : value) >>> 0;
}

export function damagePacketOwner(data) {
  return readOwner(new PacketReader(data));
}

const decodeReplicationByte = (value) => netIdTable[netIdTable[value]] ^ 0x13;
const decodeReplicationHeader = (value) => byte(swapBits(rotateLeft(swapBits(value), 5)) + 0xaa) ^ 0x6d;

// Type 952 carries object replication records. Bank 5, field 0 is current HP.
// The vector reader at 0x1010ef160 writes alternating front/back bytes.
export function decodeDamageHealthUpdates(data, targets) {
  const reader = new PacketReader(data);
  readOwner(reader);
  const [first, second] = reader.vector(2);
  if ([0, 1, 4, 5].includes(first >>> 1 & 7)) reader.vector(4);
  if ([0, 1, 2, 4].includes((first >>> 7) + (second & 3) * 2)) {
    reader.varint(decodeReplicationHeader, 0xffffffff, 0);
  }
  if ([0, 1, 3, 6].includes(first >>> 4 & 7)) reader.next();
  const size = first & 1 ? 0 : reader.varint(decodeReplicationByte, 0x7000);
  const encoded = reader.vector(size);
  if (reader.offset !== data.length) throw new RangeError('Trailing bytes in health update');
  const decoded = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) {
    const index = i % 2 ? size - 1 - (i >>> 1) : i >>> 1;
    decoded[index] = decodeReplicationByte(encoded[i]);
  }

  const records = new PacketReader(decoded);
  const updates = [];
  while (records.offset < size) {
    const banks = records.next();
    const id = records.vector(4).readUInt32LE();
    for (let bank = 0; bank < 8; bank++) {
      if (!(banks & (1 << bank))) continue;
      const fields = records.vector(4).readUInt32LE();
      const payload = records.vector(records.next());
      if (bank !== 5 || !(fields & 1) || !targets.has(id)) continue;
      // Field 0 is first in the bank. The compact zero occupies one byte.
      let health;
      if (fields === 1 && payload.length === 1 && payload[0] === 255) health = 0;
      else if (payload.length >= 4 && (fields === 1 || payload[0] !== 255)) health = payload.readFloatLE();
      updates.push({ id, health: Number.isFinite(health) && health >= 0 ? health : null });
    }
  }
  return updates;
}

// The type 393 combat display is delivered for nearby damage, including other
// attackers. Its common ID is the target and its amount is the first field.
export function decodeDamageDisplay(data) {
  const reader = new PacketReader(data);
  const targetId = readOwner(reader);
  const [, second] = reader.vector(4);
  const amountField = second >>> 4 & 7;
  let amount;
  if ([0, 1, 3, 5, 6].includes(amountField)) {
    const decoded = Buffer.from(reader.vector(4)).map((value) => rotateLeft(netIdTable[value] ^ 0x57, 1));
    amount = decoded.readFloatBE();
  } else {
    const defaults = { 2: 0x53678585, 4: 0xf9858585, 7: 0x85858585 };
    const raw = Buffer.alloc(4);
    raw.writeUInt32LE(defaults[amountField]);
    amount = raw.map((value) => rotateLeft(netIdTable[value] ^ 0x57, 1)).readFloatLE();
  }
  return { targetId, amount };
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

function skipRecapDamageDetail(reader) {
  const [first, second, third] = reader.vector(3);
  if (recapFloatFields.includes(first >>> 5)) reader.vector(4);
  if (recapAmountFields.includes(first >>> 1 & 7)) reader.vector(4);
  if ([0, 1, 3, 4].includes((second >>> 6) + (third & 1) * 4)) {
    reader.varint(decodeRecapDetailIndex, 0xffffffff);
  }
  if ([1, 2, 5, 7].includes(second >>> 3 & 7)) reader.varint(decodeRecapDurationByte, 0xffffffff);
  if ([0, 2, 6, 7].includes(second & 7)) reader.vector(4);
}

function skipRecapDamageEntry(reader) {
  const flags = reader.next();
  const length = recapStringLengths[flags >>> 1 & 3];
  if (length) reader.vector(reader.varint(length, 0x7000));
  if (!(flags & 1)) {
    const count = reader.varint(decodeRecapDetailCount, 0x7000);
    for (let i = 0; i < count; i++) skipRecapDamageDetail(reader);
  }
  if (![2, 4].includes(flags >>> 3 & 7)) reader.varint(decodeHeroId, 0xffffffff, 0);
}

// The pinned client's type 1074 reader (0x101046570) supplies the +0x2c float
// to Death Recap's FightLengthValueText. Skip the damage rows and other fields.
export function decodeDeathRecapDuration(data) {
  if (!(data instanceof Uint8Array) || !data.length || data.length >= 0x7000) {
    throw new RangeError('Invalid death recap size');
  }
  const reader = new PacketReader(data);
  readOwner(reader);
  const [first, second, third] = reader.vector(3);
  if (!(second & 2)) {
    const count = reader.varint(decodeRecapCount, 0x7000);
    for (let i = 0; i < count; i++) skipRecapDamageEntry(reader);
  }
  if ([0, 2, 6, 7].includes((second >>> 6) + (third & 1) * 4)) reader.vector(4);
  if (recapAmountFields.includes(first & 7)) reader.vector(4);
  if (![2, 4].includes((first >>> 6) + (second & 1) * 4)) reader.varint(decodeHeroId, 0xffffffff, 0);
  const durationField = second >>> 2 & 7;
  const duration = recapDurationDefaults[durationField] ??
    Buffer.from(reader.vector(4)).map(decodeRecapDurationByte).readFloatLE();
  if (recapFloatFields.includes(first >>> 3 & 7)) reader.vector(4);
  if (!(second & 0x20)) skipRecapDamageEntry(reader);
  if (reader.offset !== data.length || !Number.isFinite(duration)) throw new RangeError('Invalid death recap fields');
  return duration >= 0 ? duration : null;
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

// Type 1045 carries a vector of packet lengths and an encoded vector of bytes.
const decodeBatchLength = (value) => eventTable[swapBits(rotateLeft(value, 4))] ^ 0x1e;
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
