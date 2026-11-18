import { PacketReader } from './livePacketReader.js';

// Unit replication, after the build-specific envelope has been decoded.
// Each record is a bank mask and the unit's object ID. Every bank in the
// mask follows as a field mask and a length-prefixed payload. Bank 5,
// field 0 is the unit's current health and leads that bank's payload.
const HEALTH_BANK = 5;
const MAX_HEALTH = 1_000_000;

// A float whose first byte would read as a marker is escaped with 0xfe.
// A lone 0xff stands for zero.
function leadingFloat(payload) {
  if (!payload.length) return null;
  if (payload[0] === 0xff) return 0;
  const offset = payload[0] === 0xfe ? 1 : 0;
  return payload.length >= offset + 4 ? payload.readFloatLE(offset) : null;
}

export function readHealthUpdates(vector, isChampion) {
  const records = new PacketReader(vector);
  const updates = [];
  while (records.offset < vector.length) {
    const banks = records.next();
    const id = records.vector(4).readUInt32LE();
    for (let bank = 0; bank < 8; bank++) {
      if (!(banks & (1 << bank))) continue;
      const fields = records.vector(4).readUInt32LE();
      const payload = records.vector(records.next());
      if (bank !== HEALTH_BANK || !(fields & 1) || !isChampion(id)) continue;
      const health = leadingFloat(payload);
      if (health !== null && health >= 0 && health < MAX_HEALTH) updates.push({ id, health });
    }
  }
  return updates;
}

// The envelope readers hand back the vector in transmitted order. The
// client fills it from both ends in turn.
export function unfoldReplicationVector(encoded, decodeByte) {
  const size = encoded.length;
  const decoded = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) decoded[i % 2 ? size - 1 - (i >>> 1) : i >>> 1] = decodeByte(encoded[i]);
  return decoded;
}
