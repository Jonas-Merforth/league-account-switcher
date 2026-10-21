import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import WebSocket from 'ws';
import { FF_WORD } from './ffResearchEvidence.js';

// All probe traffic is local and read-only. TLS relaxation is limited to loopback.
export function readResearchJson({ port = 2999, endpoint, password, signal, method = 'GET', maxBytes = 8 * 1024 * 1024 }) {
  // Help is an observational POST in the game runtime schema, not a gameplay action.
  if (method !== 'GET' && !(method === 'POST' && endpoint === '/Help')) {
    return Promise.reject(Object.assign(new Error('Research method blocked'), { code: 'METHOD_BLOCKED' }));
  }
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: '127.0.0.1', port, path: endpoint, method, rejectUnauthorized: false,
      timeout: 2000, signal,
      headers: { Accept: 'application/json', ...(password ? { Authorization: `Basic ${Buffer.from(`riot:${password}`).toString('base64')}` } : {}) }
    }, (res) => {
      const chunks = []; let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) req.destroy(Object.assign(new Error('Response limit'), { code: 'RESPONSE_LIMIT' }));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { code: `HTTP_${res.statusCode}` }));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(Object.assign(new Error('Invalid JSON'), { code: 'INVALID_JSON' })); }
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Timeout'), { code: 'TIMEOUT' })));
    req.on('error', reject);
    req.end();
  });
}

export function connectResearchEvents(credentials, { onOpen, onEvent, onClose, onError, onEnvelope = () => {} }) {
  const socket = new WebSocket(`wss://127.0.0.1:${credentials.port}/`, 'wamp', {
    rejectUnauthorized: false, handshakeTimeout: 2500, maxPayload: 2 * 1024 * 1024,
    perMessageDeflate: false,
    headers: { Authorization: `Basic ${Buffer.from(`riot:${credentials.password}`).toString('base64')}` }
  });
  socket.on('open', () => { socket.send(JSON.stringify([5, 'OnJsonApiEvent'])); onOpen(); });
  socket.on('message', (bytes) => {
    try {
      const message = JSON.parse(bytes.toString('utf8'));
      if (message[0] === 8 && message[1] === 'OnJsonApiEvent' && message[2]?.uri) onEvent(message[2]);
      else if (message[0] === 8 && typeof message[1] === 'string') onEnvelope(message[1], message[2]);
    } catch { /* Ignore unrelated/non-JSON frames. */ }
  });
  socket.on('close', onClose);
  socket.on('error', () => onError('Connection failed'));
  const subscribed = new Set(['OnJsonApiEvent']);
  return {
    close: () => socket.terminate(),
    subscribe: (names) => {
      const added = [];
      if (socket.readyState !== WebSocket.OPEN) return added;
      for (const name of names) {
        if (!EXTRA_RESEARCH_EVENTS.includes(name) || subscribed.has(name)) continue;
        socket.send(JSON.stringify([5, name])); subscribed.add(name); added.push(name);
      }
      return added;
    }
  };
}

export const EXTRA_RESEARCH_EVENTS = ['OnLcdsEvent', 'OnServiceProxyAsyncEvent', 'OnServiceProxyMethodEvent', 'OnServiceProxyUuidEvent'];

// Counter metadata only. Never retain peer addresses, player IDs, or packet contents.
export function parseResearchNetworkLine(line, columns = null) {
  const values = line.split(',');
  if (columns) {
    if (values.length !== columns.length) return null;
    const counters = {};
    for (let i = 0; i < columns.length; i++) {
      const key = columns[i];
      if (!/^(game\.(time|frametime_average|frametime_variance)|stats\.duration|network\.(bytes_\w+|packets_\w+|messages_\w+|acks_\w+|rtt_\w+|processing_time|reconnects|soft_reconnects|disconnects|invalid_packets|invalid_packets_bytes)|replication\.(banks_sent|bytes_sent|fields_changed|fields_sent|objects_changed))$/.test(key)) continue;
      if (!values[i].trim() || !Number.isFinite(Number(values[i]))) continue;
      counters[key] = Number(values[i]);
    }
    if (!Number.isFinite(counters['game.time']) || !(counters['stats.duration'] > 0)) return null;
    return { format: 'netstats', sourceGameTime: counters['game.time'], durationSeconds: counters['stats.duration'], counters,
      timingMeaning: 'Game-supplied sample clock; interval alignment unverified. Final row may be a whole-session summary.' };
  }
  if (values.length !== 24 || !/^\d+$/.test(values[0])) return null;
  const keys = ['logTimeMs', null, 'incomingBytes', 'outgoingBytes', 'appClientToServerBytesDelta', 'appServerToClientBytesDelta',
    'lostPackets', 'sentPackets', 'pingMs', 'variance', 'reliableDelayed', 'unreliableDelayed', 'appUpdateDelayed',
    'criticalSectionTime', 'windowLatencyMs', 'windowPacketLossPercent', 'windowJitterMs', 'overallLatencyMinMs',
    'overallLatencyMaxMs', 'windowLatencyMinMs', 'windowLatencyMaxMs', 'latencySamples', 'jitterSamples', 'reconnect'];
  const counters = {};
  for (let i = 0; i < keys.length; i++) if (keys[i]) {
    if (!values[i].trim() || !Number.isFinite(Number(values[i]))) return null;
    counters[keys[i]] = Number(values[i]);
  }
  return { format: 'netlog', counters, timingMeaning: 'Log clock includes startup/loading; do not equate it with live game time.' };
}

// Only appended lines are eligible. Existing bytes are explicitly skipped, including at
// first attachment. No old log may masquerade as an early signal in the current game.
export class FFGameLogTail {
  constructor(getLeaguePath) { this.getLeaguePath = getLeaguePath; this.reset(); }
  reset() { this.files = new Map(); this.nextScanAt = 0; this.latestDir = ''; }

  poll(now = Date.now()) {
    const root = path.join(this.getLeaguePath(), 'Logs', 'GameLogs');
    const output = []; const notices = []; const network = [];
    if (now >= this.nextScanAt) {
      this.nextScanAt = now + 3000;
      const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory())
        .map((item) => ({ dir: path.join(root, item.name), at: fs.statSync(path.join(root, item.name)).mtimeMs }))
        .sort((a, b) => b.at - a.at).slice(0, 2);
      // Watch two directories because crash/reconnect logging can rotate during a match.
      const found = new Set();
      for (const { dir } of dirs) {
        for (const name of fs.readdirSync(dir).filter((name) => /(?:r3dlog\.txt|netlog\.txt|netstats\.csv)$/i.test(name))) {
          const file = path.join(dir, name); found.add(file);
          if (!this.files.has(file)) {
            const size = fs.statSync(file).size;
            let columns = null;
            if (/netstats\.csv$/i.test(name)) {
              const fd = fs.openSync(file, 'r'); const header = Buffer.alloc(16384); let count;
              try { count = fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
              const text = header.subarray(0, count).toString('utf8');
              if (text.includes('\n')) columns = text.split(/\r?\n/, 1)[0].split(',');
            }
            let skipFragment = false;
            if (size) {
              const fd = fs.openSync(file, 'r'); const last = Buffer.alloc(1);
              try { fs.readSync(fd, last, 0, 1, size - 1); } finally { fs.closeSync(fd); }
              skipFragment = last[0] !== 10;
            }
            this.files.set(file, { offset: size, remainder: '', decoder: new StringDecoder('utf8'), columns, skipFragment });
            notices.push({ file: path.relative(root, file), skippedBytes: size });
          }
        }
      }
      for (const file of this.files.keys()) if (!found.has(file)) this.files.delete(file);
    }
    for (const [file, state] of this.files) {
      let size;
      try { size = fs.statSync(file).size; } catch { this.files.delete(file); continue; }
      if (size < state.offset) {
        state.offset = 0; state.remainder = ''; state.decoder = new StringDecoder('utf8'); state.columns = null; state.skipFragment = false;
        notices.push({ file: path.relative(root, file), truncated: true });
      }
      if (size === state.offset) continue;
      // Bound work per tick; all remaining bytes are read on subsequent polls.
      const buffer = Buffer.alloc(Math.min(size - state.offset, 256 * 1024));
      const fd = fs.openSync(file, 'r'); let count;
      try { count = fs.readSync(fd, buffer, 0, buffer.length, state.offset); } finally { fs.closeSync(fd); }
      const offset = state.offset; state.offset += count;
      const lines = (state.remainder + state.decoder.write(buffer.subarray(0, count))).split(/\r?\n/);
      state.remainder = lines.pop().slice(-16000);
      for (const line of lines) {
        if (state.skipFragment) { state.skipFragment = false; continue; }
        if (/netstats\.csv$/i.test(file) && line.startsWith('game.frametime_average,')) { state.columns = line.split(','); continue; }
        if (/(?:netlog\.txt|netstats\.csv)$/i.test(file)) {
          const sample = /netstats\.csv$/i.test(file) && !state.columns ? null : parseResearchNetworkLine(line, state.columns);
          if (sample) network.push({ ...sample, file: path.relative(root, file), readOffset: offset,
            unreadBytes: Math.max(0, size - state.offset), gameAssociation: 'Unverified: log directory; compare sample clock and capture match' });
          continue;
        }
        if (!FF_WORD.test(line) && !/game.?end|end.?of.?game|nexus.*destroy/i.test(line)) continue;
        // Drop secret-bearing lines outright; do not attempt to salvage their surrounding text.
        if (/token|password|authorization|credential|encryption|secret|cookie|command.?line/i.test(line)) continue;
        output.push({ file: path.relative(root, file), readOffset: offset, line: line.slice(0, 8000), textTruncated: line.length > 8000,
          unreadBytes: Math.max(0, size - state.offset), gameAssociation: 'Unverified: recently modified game log' });
      }
    }
    return { fileCount: this.files.size, networkFileCount: [...this.files.keys()].filter((file) => /(?:netlog\.txt|netstats\.csv)$/i.test(file)).length,
      notices, lines: output, network };
  }
}
