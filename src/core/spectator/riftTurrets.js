export function riftTurret(name, destroyed) {
  const match = /^Turret_T(Order|Chaos)_L([012])_P([0-5])_\d+_0$/.exec(name.toString('latin1'));
  if (!match) throw new Error('Unrecognized Rift turret.');
  const [, side, lane, position] = match;
  if ((lane !== '1' && (position === '0' || position > '3')) || (position === '0' && destroyed)) {
    throw new Error('Unexpected Rift turret position or state.');
  }
  return { side, lane, position, destroyed };
}

export function countTurrets(blocks, packetId, decodeTurret) {
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
