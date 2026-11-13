// Historical research implementation. The add-on uses src/core/damagePacketFields16_22.js.
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
  varint(transform, max) {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const digit = transform(this.next());
      value += (digit & 127) * 2 ** shift;
      if (value > max) break;
      if (!(digit & 128)) return value;
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
  const encodedOwner = reader.varint(decodeNetId, 0xffffffff);
  const owner = ((encodedOwner & 0xffffff) ? encodedOwner ^ 0x40000000 : encodedOwner) >>> 0;
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
