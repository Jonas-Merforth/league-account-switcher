import { createHash } from 'node:crypto';
import { Blowfish } from 'egoroof-blowfish';
import { Decompress } from 'fzstd';
import { decodeDamageBatch, decodeDamageStatEvent } from './damagePacketFields16_22.js';

export const SUPPORTED_DAMAGE_BUILD = '16.22.8348910';
const WINDOW_MS = 5000;
const MAX_BODY = 65536;
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let value = i << 24;
  for (let bit = 0; bit < 8; bit++) value = (value << 1) ^ (value < 0 ? 0x04c11db7 : 0);
  return value;
});

export function readDamageSession(log) {
  const lines = log.split(/\r?\n/, 200);
  const version = lines.find((line) => /version/i.test(line) && /\b\d+\.\d+\.\d+\.\d+\b/.test(line));
  const match = version?.match(/\b(\d+\.\d+\.\d+)\.(\d+)\b/);
  if (!match) return null;
  if (match[1] + match[2] !== SUPPORTED_DAMAGE_BUILD) throw new Error('This League patch is unsupported by the Damage preview.');
  for (const line of lines) {
    if (!line.includes('Command')) continue;
    const launch = line.match(/"([\d.]+) (\d{1,5}) ([A-Za-z0-9+/]+={0,2}) (\d{1,20})"/);
    if (!launch) continue;
    const key = Buffer.from(launch[3], 'base64');
    const player = BigInt(launch[4]);
    const ip = launch[1].split('.').map(Number);
    const port = Number(launch[2]);
    if (key.length < 4 || key.length > 56 || player >= 2n ** 64n || ip.length !== 4 ||
        ip.some((part) => !Number.isInteger(part) || part < 0 || part > 255) || port < 1 || port > 65535) {
      throw new Error('Invalid League session data.');
    }
    return { key, player, server: Buffer.from(ip), port };
  }
  return null;
}

function decryptPass(data, cipher) {
  const output = Buffer.from(data);
  const zero = Buffer.alloc(8);
  let previous = zero;
  for (let offset = 0; offset + 8 <= data.length; offset += 8) {
    const stream = cipher.encode(previous);
    for (let i = 0; i < 8; i++) output[offset + i] ^= stream[i];
    previous = data.subarray(offset, offset + 8);
  }
  return output;
}

function checkedDatagram(wire, incoming, cipher, player) {
  const prefix = incoming ? 4 : 12;
  if (wire.length < prefix + 7) throw new Error('Short game datagram');
  const plain = decryptPass(decryptPass(wire.subarray(prefix), cipher).reverse(), cipher);
  const sequence = plain.readUInt16LE();
  const ack = sequence & 0x8000 ? plain.subarray(7, 15) : Buffer.alloc(8, 0xff);
  if (ack.length !== 8) throw new Error('Short game acknowledgment');
  const body = plain.subarray(sequence & 0x8000 ? 15 : 7);
  const header = Buffer.alloc(10);
  header.writeUInt16LE(sequence);
  header.writeBigUInt64LE(player, 2);
  let value = header.readUInt32BE() ^ 0xc704dd7b;
  for (const bytes of [header.subarray(4), ack, body]) {
    for (const next of bytes) value = ((value << 8) | next) ^ crcTable[value >>> 24];
  }
  if ((~value >>> 0) !== plain.readUInt32BE(2)) throw new Error('Game datagram checksum failed');
  return { sequence, body, compressed: !!(plain[6] & 128) };
}

function decompressBody(body) {
  if (body.length < 6 || body.readUInt32LE() !== 0xfd2fb528) throw new Error('Invalid compressed game datagram');
  const descriptor = body[4];
  const single = !!(descriptor & 32);
  if (descriptor & 8) throw new Error('Invalid compressed game header');
  if (!single && (10 + (body[5] >>> 3)) > 17) throw new Error('Compressed game window exceeds limit');
  // fzstd allocates from the declared frame size before yielding any chunks.
  const dictSize = [0, 1, 2, 4][descriptor & 3];
  const sizeBytes = [single ? 1 : 0, 2, 4, 8][descriptor >>> 6];
  const sizeAt = 5 + (single ? 0 : 1) + dictSize;
  if (sizeAt + sizeBytes > body.length) throw new Error('Truncated compressed game datagram');
  if (sizeBytes) {
    const size = sizeBytes === 8 ? body.readBigUInt64LE(sizeAt) : BigInt(body.readUIntLE(sizeAt, sizeBytes));
    if (size + (sizeBytes === 2 ? 256n : 0n) > BigInt(MAX_BODY)) throw new Error('Compressed game body exceeds limit');
  }
  // Validate the single-frame boundary before passing data to the decoder.
  let end = sizeAt + sizeBytes;
  let last = false;
  while (!last) {
    if (end + 3 > body.length) throw new Error('Truncated compressed game block');
    const block = body.readUIntLE(end, 3);
    last = !!(block & 1);
    const kind = block >>> 1 & 3;
    if (kind === 3) throw new Error('Invalid compressed game block');
    end += 3 + (kind === 1 ? 1 : block >>> 3);
  }
  if (end + (descriptor & 4 ? 4 : 0) !== body.length) throw new Error('Invalid compressed game boundary');
  let size = 0;
  const chunks = [];
  const stream = new Decompress((chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Decompressed game body exceeds limit');
    chunks.push(chunk);
  });
  stream.push(body, true);
  return Buffer.concat(chunks, size);
}

function readMessages(body) {
  let cursor = 0;
  let channel = 0;
  let sequence = 0;
  const messages = [];
  function take(size) {
    if (cursor + size > body.length) throw new Error('Truncated game message');
    const data = body.subarray(cursor, cursor + size);
    cursor += size;
    return data;
  }
  while (cursor < body.length) {
    const header = take(2).readUInt16LE();
    if (!(header & 16)) channel = take(1)[0];
    sequence = header & 8 ? (sequence + 1) & 65535 : take(2).readUInt16LE();
    const fragment = header & 4 ? take(2) : null;
    if (fragment && fragment[1] >= fragment[0]) throw new Error('Invalid game fragment index');
    if ((header & 3) === 3) {
      for (let i = 0; i < 5; i++) {
        const digit = take(1)[0];
        if (i === 4 && digit > 15) throw new Error('Invalid game message varint');
        if (!(digit & 128)) break;
      }
    }
    messages.push({ channel, sequence, fragment, data: take(header >>> 6) });
  }
  return messages;
}

function digest(data) { return createHash('sha256').update(data).digest('base64'); }

export class DamageWire {
  constructor({ key, player, onDamage, onPacket = () => {} }) {
    this.cipher = new Blowfish(key, Blowfish.MODE.ECB, Blowfish.PADDING.NULL);
    this.player = player;
    this.onDamage = onDamage;
    this.onPacket = onPacket;
    this.seen = new Map();
    this.fragments = new Map();
    this.incomingSequences = new Map();
    this.pendingAcks = new Map();
    this.lastSweep = 0;
    this.stats = { checked: 0, rejected: 0, missing: 0, fragmentLoss: 0 };
  }

  sweep(now) {
    if (now - this.lastSweep < 1000) return;
    this.lastSweep = now;
    for (const [mapKey, time] of this.seen) if (now - time > WINDOW_MS) this.seen.delete(mapKey);
    for (const [mapKey, time] of this.incomingSequences) if (now - time > WINDOW_MS) this.incomingSequences.delete(mapKey);
    for (const [mapKey, time] of this.pendingAcks) {
      if (now - time <= WINDOW_MS) continue;
      this.stats.missing++;
      this.pendingAcks.delete(mapKey);
    }
    for (const [mapKey, group] of this.fragments) {
      if (now - group.time <= WINDOW_MS) continue;
      this.stats.fragmentLoss++;
      this.fragments.delete(mapKey);
    }
  }

  finish() {
    this.stats.missing += this.pendingAcks.size;
    this.stats.fragmentLoss += this.fragments.size;
    this.pendingAcks.clear();
    this.fragments.clear();
  }

  push(wire, direction, localPort, time) {
    this.sweep(time);
    const incoming = direction === 'in';
    let packet, messages;
    try {
      packet = checkedDatagram(wire, incoming, this.cipher, this.player);
      this.stats.checked++;
      const datagramId = `d:${localPort}:${direction}:${packet.sequence}:${digest(wire)}`;
      if (time - (this.seen.get(datagramId) ?? -Infinity) <= WINDOW_MS) return;
      this.seen.set(datagramId, time);
      if (incoming && !(packet.sequence & 0x8000)) {
        const key = `${localPort}:${packet.sequence}`;
        this.incomingSequences.set(key, time);
        this.pendingAcks.delete(key);
      } else if (!incoming && (packet.sequence & 0x8000)) {
        const key = `${localPort}:${65536 - packet.sequence}`;
        if (!this.incomingSequences.has(key) && !this.pendingAcks.has(key)) this.pendingAcks.set(key, time);
      }
      messages = readMessages(packet.compressed ? decompressBody(packet.body) : packet.body);
    } catch { this.stats.rejected++; return; }
    for (const message of messages) {
      const identity = `${localPort}:${direction}:${message.channel}:${message.sequence}`;
      const data = this.reassemble(message, identity, time);
      if (!data) continue;
      const messageId = `m:${identity}:${digest(data)}`;
      if (time - (this.seen.get(messageId) ?? -Infinity) <= WINDOW_MS) continue;
      this.seen.set(messageId, time);
      try { this.dispatch(data, direction, `${messageId}:${time}`, time, 0); }
      catch { this.stats.rejected++; }
    }
  }

  reassemble({ fragment, data }, identity, time) {
    if (!fragment) return data;
    const [count, index] = fragment;
    const key = `${identity}:${count}`;
    if (!this.fragments.has(key)) {
      if (this.fragments.size >= 128) { this.stats.fragmentLoss++; return null; }
      this.fragments.set(key, { time, parts: new Map(), size: 0 });
    }
    const group = this.fragments.get(key);
    const previous = group.parts.get(index);
    if (previous?.equals(data)) return null;
    if (previous || group.size + data.length > MAX_BODY) {
      this.fragments.delete(key);
      this.stats.fragmentLoss++;
      return null;
    }
    group.parts.set(index, data);
    group.size += data.length;
    if (group.parts.size !== count) return null;
    this.fragments.delete(key);
    return Buffer.concat(Array.from({ length: count }, (_, i) => group.parts.get(i)), group.size);
  }

  dispatch(data, direction, id, time, depth) {
    if (!data.length || (data[0] >= 251 && data.length < 2)) throw new Error('Short application packet');
    const size = data[0] < 251 ? 1 : 2;
    const type = size === 1 ? data[0] : 251 + (data[0] - 251) * 256 + data[1];
    const fields = data.subarray(size);
    if (type === 1045 && direction === 'in') {
      if (depth >= 2) throw new Error('Game batch nesting exceeds limit');
      decodeDamageBatch(fields).forEach((part, index) => this.dispatch(part, direction, `${id}:${index}`, time, depth + 1));
      return;
    }
    this.onPacket({ type, fields, direction, time });
    if (direction === 'in' && type === 743) {
      const event = decodeDamageStatEvent(fields);
      if (event) this.onDamage({ ...event, id, time });
    }
  }
}
