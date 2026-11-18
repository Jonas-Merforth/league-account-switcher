export const netIdTable = Buffer.from('d75682dc83028f2935042171799e927fcb976a5105c76fe640637e345b4707785a96b8b92c995e6ed1754161245f4aaa4bcf0ed4865dba1d3f2bdf62f0330055cafc19acf3662369bceb46f89c50874d6d108e88be1bb5da4e1a13cc2209ada49d30a6e57dfac91712c2fde1bbe70b98bfbd1137c07cf795b6dd49f4812a9f1cfb8d9a727b577a43b3a953e459202fa8f67436a085f1a7147031840cb2a5dbe816ae3d25b1cd9b0367155cea1f39a1440a8b76de606593f264d5c1c84c064fb7edfee0f9a2184891ce1e3cb46c425494e328e90127ec0d45ff26efe28aabd9f508c4af32c56b80c6c358eea33e2d0f893ab0d2d33873d8d08c7790523bd62e68', 'hex');

export const byte = (value) => value & 255;
export const rotateLeft = (value, count) => byte(value << count | value >>> (8 - count));
export const swapBits = (value) => (value >>> 1 & 0x55) | (value << 1 & 0xaa);

export class PacketReader {
  constructor(data) { this.data = data; this.offset = 0; }
  next() {
    if (this.offset >= this.data.length) throw new RangeError('Truncated packet envelope');
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
    if (size > this.data.length - this.offset) throw new RangeError('Truncated packet vector');
    const result = this.data.subarray(this.offset, this.offset + size);
    this.offset += size;
    return result;
  }
}

export const decodeNetId = (value) => netIdTable[byte(netIdTable[rotateLeft(byte(netIdTable[value ^ 255] + 0x54), 1)] + 0xb4)];

export function readOwner(reader) {
  const value = reader.varint(decodeNetId, 0xffffffff);
  return ((value & 0xffffff) ? value ^ 0x40000000 : value) >>> 0;
}

export function damagePacketOwner(data) {
  return readOwner(new PacketReader(data));
}

export function readDisplayVarint(reader, transform, id) {
  let value = 0;
  for (let shift = 0; ; shift += 7) {
    const digit = transform(reader.next());
    // JS masks the shift count to five bits, like the client's shl.
    value = (value | (digit & 127) << shift) >>> 0;
    if (!(digit & 128)) return id && (value & 0xffffff) ? (value ^ 0x40000000) >>> 0 : value;
  }
}
