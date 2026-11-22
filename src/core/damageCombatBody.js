const DAMAGE_SCHEMA = 0x2839cc82;
const DAMAGE_EVENT_BYTES = 96;
// Heals are sent for every visible champion, not only the local player.
// The healer owns the event. Offset 4 names the healed unit and 24 holds
// the health restored.
const HEAL_SCHEMA = 0x7c044fe1;
const HEAL_KIND = 75;
const HEAL_EVENT_BYTES = 52;

function decodeBody(vector, decodeByte) {
  const size = vector.length;
  const body = Buffer.alloc(size);
  for (let i = 0; i < size; i++) body[size - i - 1] = decodeByte(vector[i]);
  return body;
}

// The live team estimate adds heals back to turn a health change into damage,
// and the healing meter credits them to the healer.
function decodeHeal(owner, schema, kind, vector, decodeByte) {
  if (schema !== HEAL_SCHEMA || kind !== HEAL_KIND || vector.length !== HEAL_EVENT_BYTES) return null;
  const body = decodeBody(vector, decodeByte);
  const targetId = body.readUInt32LE(4);
  const amount = body.readFloatLE(24);
  return owner && targetId && Number.isFinite(amount) && amount > 0 ? { support: 'heal', sourceId: owner, targetId, amount } : null;
}

export function decodeCombatBody(owner, schema, kind, vector, decodeByte) {
  const personal = schema === DAMAGE_SCHEMA && (kind === 24 || kind === 25);
  const kill = schema === 0xd83b6b03 && kind === 4;
  // Kind 86 can duplicate 87 and can also describe non-champion events.
  const assist = schema === 0x7c689a48 && kind === 87;
  if (!personal && !kill && !assist) return decodeHeal(owner, schema, kind, vector, decodeByte);
  const size = vector.length;
  if (size !== (kill ? 108 : assist ? 36 : DAMAGE_EVENT_BYTES)) throw new RangeError('Unexpected damage event body size');
  const body = decodeBody(vector, decodeByte);
  const peer = body.readUInt32LE(4);
  if (kill || assist) {
    if (!owner || !peer || owner === peer) return null;
    if (kill) {
      const amount = body.readFloatLE(104);
      if (body.readUInt32LE(12) !== owner || !Number.isFinite(amount) || amount <= 0) return null;
      return { takedown: 'finalHit', sourceId: peer, targetId: owner, amount };
    }
    const schools = { physical: body.readFloatLE(12), magic: body.readFloatLE(16), true: body.readFloatLE(20) };
    if (owner === body.readUInt32LE(32) || Object.values(schools).some((n) => !Number.isFinite(n) || n < 0)) return null;
    const amount = schools.physical + schools.magic + schools.true;
    // An assist without damage, such as a heal on the killer, still says
    // that this champion dealt none to the victim before it died.
    return amount > 0 ? { takedown: 'assist', sourceId: owner, targetId: peer, amount, schools }
      : { support: 'assist', sourceId: owner, targetId: peer, amount: 0 };
  }
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
    // Lowercase ELF hashes of spell script names, or FNV-1a hashes of a
    // spell origin such as SpellOriginItem. Offset 80 names the root spell,
    // 16 the script that applied the damage and 48 its missile or sub-spell.
    candidateHash: body.readUInt32LE(80),
    candidateScriptHash: body.readUInt32LE(16),
    candidateMissileHash: body.readUInt32LE(48),
    // Usually the spell slot (Q/W/E/R are 0-3, basic attacks 64+), but it
    // has also held an item ID. Kept for research only.
    candidateSlot: body.readUInt32LE(84),
    statDirection: kind === 25 ? 'outgoing' : 'incoming'
  };
}
