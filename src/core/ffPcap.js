import fs from 'node:fs';
import crypto from 'node:crypto';

// Streaming, bounded PCAPNG reader. Preserve the original capture for unsupported
// link/protocol types; never treat a guessed payload offset as a decoded message.
export function indexPcap(file, indexFile, localPorts = []) {
  const fd = fs.openSync(file, 'r');
  const output = fs.openSync(indexFile, 'wx');
  const summary = { packets: 0, udpPackets: 0, truncatedPackets: 0, unsupportedPackets: 0,
    firstPacketAt: null, lastPacketAt: null, interfaces: [],
    meaning: 'Raw packet observations; multiple NICs can duplicate packets. No surrender payload decoder.' };
  let offset = 0; let little = true; let interfaces = [];
  const read = (size, position) => {
    const b = Buffer.alloc(size);
    if (fs.readSync(fd, b, 0, size, position) !== size) throw new Error('Truncated PCAPNG block');
    return b;
  };
  try {
    const size = fs.fstatSync(fd).size;
    while (offset < size) {
      const header = read(12, offset);
      const section = header.readUInt32LE(0) === 0x0a0d0d0a;
      if (section) {
        if (header.readUInt32LE(8) === 0x1a2b3c4d) little = true;
        else if (header.readUInt32BE(8) === 0x1a2b3c4d) little = false;
        else throw new Error('Invalid PCAPNG byte order');
        interfaces = [];
      }
      const u32 = (b, at) => little ? b.readUInt32LE(at) : b.readUInt32BE(at);
      const u16 = (b, at) => little ? b.readUInt16LE(at) : b.readUInt16BE(at);
      const length = u32(header, 4); const type = u32(header, 0);
      if (length < 12 || length % 4 || length > 16 * 1024 * 1024 || offset + length > size) throw new Error('Invalid PCAPNG block length');
      const block = read(length, offset);
      if (u32(block, length - 4) !== length) throw new Error('PCAPNG block trailer mismatch');
      if (type === 1) {
        if (length < 20) throw new Error('Invalid interface block');
        const iface = { linkType: u16(block, 8), secondsPerTick: 1e-6, offsetSeconds: 0 };
        for (let p = 16; p + 4 <= length - 4;) {
          const code = u16(block, p); const n = u16(block, p + 2); p += 4;
          if (p + n > length - 4) throw new Error('Invalid interface option');
          if (code === 0) break;
          if (code === 9 && n === 1) iface.secondsPerTick = block[p] & 128 ? 2 ** -(block[p] & 127) : 10 ** -block[p];
          if (code === 14 && n === 8) iface.offsetSeconds = Number(little ? block.readBigInt64LE(p) : block.readBigInt64BE(p));
          p += Math.ceil(n / 4) * 4;
        }
        interfaces.push(iface); summary.interfaces.push(iface);
      } else if (type === 6) {
        if (length < 32) throw new Error('Invalid enhanced packet block');
        const interfaceId = u32(block, 8); const iface = interfaces[interfaceId];
        if (!iface) throw new Error('Unknown packet interface');
        const capturedLength = u32(block, 20); const originalLength = u32(block, 24);
        if (28 + Math.ceil(capturedLength / 4) * 4 > length - 4) throw new Error('Truncated packet bytes');
        const ticks = (BigInt(u32(block, 12)) << 32n) | BigInt(u32(block, 16));
        const unixMs = Number(ticks) * iface.secondsPerTick * 1000 + iface.offsetSeconds * 1000;
        const packet = block.subarray(28, 28 + capturedLength);
        const row = { packet: ++summary.packets, fileOffset: offset, interfaceId, unixMs,
          utc: new Date(unixMs).toISOString(), capturedLength, originalLength,
          frameHash: crypto.createHash('sha256').update(packet).digest('hex') };
        if (capturedLength < originalLength) summary.truncatedPackets++;
        Object.assign(row, udpMetadata(packet, iface.linkType, localPorts));
        if (row.protocol === 'UDP') summary.udpPackets++; else summary.unsupportedPackets++;
        summary.firstPacketAt = summary.firstPacketAt === null ? unixMs : Math.min(summary.firstPacketAt, unixMs);
        summary.lastPacketAt = summary.lastPacketAt === null ? unixMs : Math.max(summary.lastPacketAt, unixMs);
        fs.writeSync(output, `${JSON.stringify(row)}\n`);
      }
      offset += length;
    }
    if (!summary.interfaces.length) throw new Error('No PCAPNG interfaces');
    return summary;
  } finally { fs.closeSync(fd); fs.closeSync(output); }
}

export function udpMetadata(bytes, linkType, ports = []) {
  if (linkType !== 1 || bytes.length < 14) return { protocol: 'unsupported' };
  let at = 14; let ether = bytes.readUInt16BE(12);
  while ([0x8100, 0x88a8].includes(ether) && bytes.length >= at + 4) { ether = bytes.readUInt16BE(at + 2); at += 4; }
  let source; let destination; let end;
  if (ether === 0x0800 && bytes.length >= at + 20) {
    const ihl = (bytes[at] & 15) * 4;
    const totalLength = bytes.readUInt16BE(at + 2);
    if (ihl < 20 || totalLength < ihl + 8 || bytes[at + 9] !== 17 || (bytes.readUInt16BE(at + 6) & 0x3fff)) return { protocol: 'unsupported' };
    source = [...bytes.subarray(at + 12, at + 16)].join('.'); destination = [...bytes.subarray(at + 16, at + 20)].join('.');
    end = Math.min(bytes.length, at + totalLength); at += ihl;
  } else if (ether === 0x86dd && bytes.length >= at + 40 && bytes[at + 6] === 17) {
    const ip6 = (start) => Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(start + i * 2).toString(16)).join(':');
    source = ip6(at + 8); destination = ip6(at + 24);
    end = Math.min(bytes.length, at + 40 + bytes.readUInt16BE(at + 4)); at += 40;
  } else return { protocol: 'unsupported' };
  if (end < at + 8) return { protocol: 'unsupported' };
  const sourcePort = bytes.readUInt16BE(at); const destinationPort = bytes.readUInt16BE(at + 2); const udpLength = bytes.readUInt16BE(at + 4);
  if (udpLength < 8) return { protocol: 'unsupported' };
  const payload = bytes.subarray(at + 8, Math.min(end, at + udpLength));
  const outgoing = ports.includes(sourcePort); const incoming = ports.includes(destinationPort);
  return { protocol: 'UDP', source, destination, sourcePort, destinationPort,
    direction: outgoing === incoming ? 'unknown' : outgoing ? 'outgoing' : 'incoming',
    udpLength, payloadBytes: payload.length, payloadTruncated: payload.length < udpLength - 8,
    payloadHash: crypto.createHash('sha256').update(payload).digest('hex') };
}
