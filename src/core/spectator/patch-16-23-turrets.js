import { PacketReader, byte, netIdTable as table, rotateLeft, swapBits } from '../livePacketReader.js';

// Packet 921, build 16.23.839.6405. Read the canonical name from +0x18.
// Entity IDs vary with the match. The scoreboard uses the defending team's
// lane and position, which also distinguishes the two fountain turrets.
const nameBytes = [
  null,
  (v) => rotateLeft(table[rotateLeft(swapBits(rotateLeft(v, 5)), 1)] ^ 0x61, 4) ^ 255,
  (v) => table[byte(rotateLeft(rotateLeft(v ^ 0x4d, 6) ^ 0x3a, 5) + 0x27)],
  (v) => byte((rotateLeft(byte(rotateLeft(v, 5) + 0x60), 3) ^ 0xc2) + 0x63)
];
const typeBytes = [
  (v) => byte(swapBits(table[table[table[swapBits(v)] ^ 255] ^ 255]) + 0x1b),
  (v) => rotateLeft(byte(swapBits(v ^ 0x9a) + 0x7b) ^ 5, 7),
  (v) => rotateLeft(rotateLeft(byte(0x3b - v), 3) ^ 255, 4) ^ 255,
  null
];
const timeByte = (v) => table[byte((byte(v + 0xa3) ^ 0xdd) + 0x50)];
const idByte = (v) => rotateLeft(swapBits(rotateLeft(table[v], 3)) ^ 0xbc, 6);
const classByte = (v) => table[swapBits(rotateLeft(byte(v + 0xbc), 3))];
const destroyedTimeByte = (v) => rotateLeft(table[rotateLeft(swapBits(byte((v ^ 0x5b) + 0x8e)), 1)], 4);

export function decodeTurret(payload) {
  const reader = new PacketReader(payload);
  const [first, second, third] = reader.vector(3);
  const destroyed = Boolean(first & 4);
  if (destroyed !== Boolean(first & 0x40) || destroyed === Boolean(second & 2)
      || ((third >>> 1) & 7) !== 1) {
    throw new Error('Unverified turret state.');
  }
  if (destroyed) reader.varint(timeByte, 0xffffffff, 0);
  const ownerSelector = (second >>> 3) & 7;
  if (ownerSelector !== 3 && ownerSelector !== 4) reader.varint(idByte, 0xffffffff);

  const nameSelector = (first >>> 7) + (second & 1) * 2;
  const transform = nameBytes[nameSelector];
  if (!transform) throw new Error('Missing turret name.');
  const length = reader.varint(transform, 64);
  const name = Buffer.from(reader.vector(length)).map(transform);
  if (nameSelector === 1) name.reverse();
  const match = /^Turret_T(Order|Chaos)_L([012])_P([0-5])_\d+_0$/.exec(name.toString('latin1'));
  if (!match) throw new Error('Unrecognized Rift turret.');

  if ([1, 2, 4, 6].includes(first >>> 3 & 7)) reader.varint(classByte, 0xffffffff);
  const typeByte = typeBytes[first & 3];
  if (typeByte) reader.vector(reader.varint(typeByte, 64));
  if (destroyed) reader.varint(destroyedTimeByte, 0xffffffff);
  if ([0, 1, 3, 6].includes((second >>> 6) + (third & 1) * 4)) reader.next();
  if (reader.offset !== payload.length) throw new Error('Trailing turret data.');
  const [, side, lane, position] = match;
  if ((lane !== '1' && (position === '0' || position > '3')) || (position === '0' && destroyed)) {
    throw new Error('Unexpected Rift turret position or state.');
  }
  return { side, lane, position, destroyed };
}

export function countRiftTurrets(blocks, packetId) {
  const positions = new Set();
  const entities = new Set();
  const totals = { 100: 0, 200: 0 };
  for (const block of blocks) {
    if (block.packetId !== packetId) continue;
    if (entities.has(block.param) || block.length !== block.payload?.length) throw new Error('Invalid turret block.');
    const { side, lane, position, destroyed } = decodeTurret(block.payload);
    const key = `${side}/${lane}/${position}`;
    if (positions.has(key)) throw new Error('Duplicate Rift turret position.');
    positions.add(key);
    entities.add(block.param);
    if (destroyed) totals[side === 'Order' ? 200 : 100]++;
  }
  if (positions.size !== 24) throw new Error('Incomplete Rift turret set.');
  return totals;
}
