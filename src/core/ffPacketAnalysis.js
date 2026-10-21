import fs from 'node:fs';
import readline from 'node:readline';

export function clockEstimate(unixMs, anchors, matchIndex = null) {
  const candidates = anchors.filter((a) => matchIndex === null || a.matchIndex === matchIndex);
  const closest = candidates.reduce((best, a) => !best || Math.abs(a.midpoint - unixMs) < Math.abs(best.midpoint - unixMs) ? a : best, null);
  if (!closest || Math.abs(closest.midpoint - unixMs) > 5000) return null;
  return { gameTime: closest.gameTime + (unixMs - closest.midpoint) / 1000,
    matchIndex: closest.matchIndex, anchorDistanceMs: Math.abs(closest.midpoint - unixMs), requestWindowMs: closest.requestWindowMs,
    meaning: 'Approximate mapping assuming game clock advances normally; pauses, clock corrections and request timing can invalidate it' };
}

export async function analyzePacketCapture(captureFile, indexFile) {
  const rows = fs.readFileSync(captureFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const anchors = rows.filter((r) => r.kind === 'sample' && r.data?.clockAnchor).map((r) => {
    const a = r.data.clockAnchor; const start = Date.parse(a.requestedAt); const end = Date.parse(a.receivedAt);
    return { matchIndex: r.matchIndex, gameTime: a.gameTime, midpoint: (start + end) / 2, requestWindowMs: end - start };
  }).filter((a) => Number.isFinite(a.midpoint) && Number.isFinite(a.gameTime) && a.requestWindowMs >= 0);
  const observations = rows.filter((r) => ['marker', 'alignment-candidate'].includes(r.kind) && r.stage !== 'note').map((r) => {
    let unixMs = Date.parse(r.receivedAt); let alignment = 'Recorder arrival; includes observation/delivery delay';
    if (r.kind === 'marker' && Number.isFinite(r.data?.observedGameTime)) {
      const nearest = anchors.filter((a) => a.matchIndex === r.matchIndex).sort((a, b) => Math.abs(a.gameTime - r.data.observedGameTime) - Math.abs(b.gameTime - r.data.observedGameTime))[0];
      if (nearest && Math.abs(nearest.gameTime - r.data.observedGameTime) <= 5) {
        unixMs = nearest.midpoint + (r.data.observedGameTime - nearest.gameTime) * 1000;
        alignment = 'Manual game/chat timestamp mapped with a nearby game-clock anchor; approximate';
      } else { unixMs = null; alignment = 'No nearby clock anchor for the manually supplied game time'; }
    }
    return { rowId: r.id, kind: r.kind, stage: r.stage, side: r.side, historical: r.historical,
      unixMs, alignment, suppliedChatTimestamp: r.data?.sourceTimestamp || null,
      windowMs: 3000, packets: 0, udpPackets: 0, bytes: 0, incoming: 0, outgoing: 0, possibleDuplicates: 0, packetExamples: [] };
  });
  const bins = new Map(); const hashes = new Map();
  let count = 0; let aligned = 0; let duplicates = 0;
  const reader = readline.createInterface({ input: fs.createReadStream(indexFile), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line.trim()) continue;
    const packet = JSON.parse(line); count++;
    const estimate = clockEstimate(packet.unixMs, anchors); if (estimate) aligned++;
    // Heuristic only: NIC duplicates and genuine retransmissions can look identical.
    const previous = hashes.get(packet.frameHash);
    const possibleDuplicate = previous !== undefined && Math.abs(packet.unixMs - previous) <= 2;
    hashes.set(packet.frameHash, packet.unixMs);
    if (hashes.size > 20000) hashes.delete(hashes.keys().next().value);
    if (possibleDuplicate) duplicates++;
    if (estimate) {
      const key = `${estimate.matchIndex}:${Math.floor(estimate.gameTime)}`;
      const bin = bins.get(key) || { matchIndex: estimate.matchIndex, gameSecond: Math.floor(estimate.gameTime), packets: 0, bytes: 0, possibleDuplicates: 0 };
      bin.packets++; bin.bytes += packet.capturedLength; if (possibleDuplicate) bin.possibleDuplicates++;
      bins.set(key, bin);
    }
    for (const observation of observations) {
      if (observation.unixMs === null || Math.abs(packet.unixMs - observation.unixMs) > observation.windowMs) continue;
      observation.packets++; observation.bytes += packet.capturedLength;
      if (packet.protocol === 'UDP') observation.udpPackets++;
      if (['incoming', 'outgoing'].includes(packet.direction)) observation[packet.direction]++;
      if (possibleDuplicate) observation.possibleDuplicates++;
      if (observation.packetExamples.length < 12) observation.packetExamples.push({ packet: packet.packet, fileOffset: packet.fileOffset,
        unixMs: packet.unixMs, direction: packet.direction, payloadBytes: packet.payloadBytes, payloadHash: packet.payloadHash, estimatedGameTime: estimate?.gameTime ?? null });
    }
  }
  return { packets: count, alignedPackets: aligned, possibleDuplicates: duplicates, clockAnchors: anchors.length,
    limitations: ['No surrender packet decoder. Packet-size/rate changes alone are not vote evidence.',
      'Raw records are retained. Duplicate estimates do not remove packets.',
      'Clock mapping is approximate; chat source timestamps are preserved but not trusted for alignment.',
      'Historical chat entries are not live detections. Enemy visibility remains unproven.'],
    observations, oneSecondBins: [...bins.values()] };
}
