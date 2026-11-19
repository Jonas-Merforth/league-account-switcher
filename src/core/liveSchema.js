import { PacketReader, readDisplayVarint } from './livePacketReader.js';

const positions = {
  forward: (i) => i,
  reverse: (i, size) => size - 1 - i,
  'outside-in': (i, size) => i & 1 ? size - 1 - (i >>> 1) : i >>> 1,
  'outside-in-back': (i, size) => i & 1 ? i >>> 1 : size - 1 - (i >>> 1)
};

function substitution(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{512}$/.test(hex)) throw new Error('Invalid protocol byte table');
  const bytes = Buffer.from(hex, 'hex');
  return (value) => bytes[value];
}

const objectId = (n) => ((n & 0xffffff) ? n ^ 0x40000000 : n) >>> 0;
const empty = Buffer.alloc(0);

function compileReader(spec, field, role, records) {
  const transform = spec.table && substitution(spec.table);
  const maxSize = role === 'turret' ? 64 : field.name === 'model' ? 128 : 0x7000;
  if (spec.kind === 'fixed') {
    if (!field.name) return (reader) => { reader.vector(spec.size); };
    const tables = spec.tables?.map(substitution);
    return (reader) => {
      if (spec.size === 1) return (tables?.[0] ?? transform)(reader.next());
      const raw = Buffer.allocUnsafe(spec.size);
      for (let i = 0; i < raw.length; i++) raw[spec.order[i]] = (tables?.[i] ?? transform)(reader.next());
      return field.type === 'float' ? raw.readFloatLE() : raw.readUIntLE(0, raw.length);
    };
  }
  if (spec.kind === 'varint') {
    // Floating combat text uses the game's wrapping uint32 accumulator.
    if (role === 'display') return (reader) => readDisplayVarint(reader, transform, spec.objectId);
    return (reader) => {
      const n = reader.varint(transform, spec.width === 2 ? 0xffff : 0xffffffff);
      return spec.objectId ? objectId(n) : n;
    };
  }
  if (spec.kind === 'struct') return (reader) => records[spec.layout](reader).values;
  if (spec.kind === 'structs') {
    const count = substitution(spec.count);
    return (reader) => {
      const size = reader.varint(count, 0x7000);
      if (size > reader.data.length - reader.offset) throw new RangeError('Truncated recap list');
      const items = [];
      for (let i = 0; i < size; i++) {
        const item = records[spec.layout](reader);
        if (field.name) items.push(item.values);
      }
      return items;
    };
  }
  const position = positions[spec.order];
  if (!position) throw new Error('Unknown protocol vector order');
  if (spec.kind === 'bytes') {
    const length = substitution(spec.length);
    return (reader) => {
      const data = reader.vector(reader.varint(length, maxSize));
      if (!field.name) return;
      const bytes = Buffer.allocUnsafe(data.length);
      for (let i = 0; i < bytes.length; i++) bytes[position(i, bytes.length)] = transform(data[i]);
      return bytes;
    };
  }
  if (spec.kind === 'varints') {
    const count = substitution(spec.count);
    const max = 2 ** (spec.width * 8) - 1;
    return (reader) => {
      const size = reader.varint(count, 4096);
      if (size > reader.data.length - reader.offset) throw new RangeError('Truncated integer list');
      const values = Array(size);
      for (let i = 0; i < size; i++) values[position(i, size)] = reader.varint(transform, max);
      return values;
    };
  }
  throw new Error('Unknown protocol reader');
}

export function compileLayouts(profile) {
  const ownerByte = substitution(profile.owner);
  const ownerFrom = (reader) => objectId(reader.varint(ownerByte, 0xffffffff));
  const decode = {};
  const records = {};
  for (const [role, layout] of Object.entries(profile.layouts)) {
    const fields = layout.fields.map((field) => {
      const [start, width] = field.bits;
      const readers = field.readers.map((spec) => compileReader(spec, field, role, records));
      const cases = field.cases.map((c) => c && typeof c === 'object' ? readers[c.read]
        : c ?? (field.type === 'bytes' ? empty : undefined));
      const index = start >>> 3;
      return {
        name: field.name,
        select: (flags) => cases[((flags[index] | flags[index + 1] << 8) >>> (start & 7)) & ((1 << width) - 1)]
      };
    });
    const named = Object.fromEntries(fields.filter((f) => f.name).map((f) => [f.name, f.select]));
    records[role] = (reader) => {
      const flags = reader.vector(layout.flagBytes);
      if (role === 'marker' && (![0, 1].includes(named.kind(flags)) || typeof named.time(flags) !== 'function')) return null;
      if (role === 'heroStats' && typeof named.counter(flags) === 'function') return null;
      const values = {};
      const present = {};
      for (const field of fields) {
        const selected = field.select(flags);
        const read = typeof selected === 'function';
        const value = read ? selected(reader) : selected;
        if (field.name) {
          values[field.name] = value;
          present[field.name] = read;
        }
      }
      return { values, present };
    };
    decode[role] = (data, spectator = false) => {
      if (!(data instanceof Uint8Array) || !data.length) throw new RangeError('Invalid packet size');
      const reader = new PacketReader(data);
      const owner = spectator ? null : ownerFrom(reader);
      const packet = records[role](reader);
      if (!packet) return null;
      if (reader.offset !== data.length) throw new RangeError('Trailing packet bytes');
      packet.values.owner = owner;
      return packet;
    };
  }
  return { decode, damagePacketOwner: (data) => ownerFrom(new PacketReader(data)) };
}
