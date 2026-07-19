function intersectSets(sets) {
  if (!sets.length) return new Set();
  const [first, ...rest] = sets;
  return new Set([...first].filter((value) => rest.every((set) => set.has(value))));
}

function entityParam(block) {
  return block.param >>> 0;
}

export function inferPlayerEntityBase(blocks) {
  const byParam = new Map();
  for (const block of blocks) {
    const param = entityParam(block);
    if ((param & 0xff000000) !== 0x40000000) continue;
    let entry = byParam.get(param);
    if (!entry) {
      entry = { count: 0, packetIds: new Set() };
      byParam.set(param, entry);
    }
    entry.count += 1;
    entry.packetIds.add(block.packetId);
  }

  let best = null;
  for (const base of byParam.keys()) {
    if ((base & 0xff) > 246) continue;
    const entries = Array.from({ length: 10 }, (_, index) => byParam.get((base + index) >>> 0));
    if (entries.some((entry) => !entry || entry.count < 10)) continue;
    const commonPacketIds = intersectSets(entries.map((entry) => entry.packetIds));
    const minimumBlocksPerSlot = Math.min(...entries.map((entry) => entry.count));
    const totalBlocks = entries.reduce((sum, entry) => sum + entry.count, 0);
    const predecessor = byParam.get((base - 1) >>> 0)?.count ?? 0;
    const score = commonPacketIds.size * 1_000 + minimumBlocksPerSlot * 2 + totalBlocks - predecessor;
    if (!best || score > best.score) {
      best = {
        base: base >>> 0,
        baseHex: `0x${(base >>> 0).toString(16).padStart(8, '0')}`,
        commonPacketIds: commonPacketIds.size,
        minimumBlocksPerSlot,
        score,
        confidence: commonPacketIds.size >= 8 && minimumBlocksPerSlot >= 40 ? 'high' : 'medium'
      }
    }
  }
  return best;
}
