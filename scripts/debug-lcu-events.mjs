import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';

import { resolveLeaguePath } from '../src/core/config.js';

const outputPath = process.argv[2];
if (!outputPath) throw new Error('Usage: node scripts/debug-lcu-events.mjs <output.jsonl>');

const leaguePath = resolveLeaguePath();

function readCredentials() {
  const lockfile = fs.readFileSync(path.join(leaguePath, 'lockfile'), 'utf8').trim();
  const [, , portText, password] = lockfile.split(':');
  const port = Number(portText);
  if (!port || !password) throw new Error('League lockfile is incomplete');
  return {
    port,
    auth: `Basic ${Buffer.from(`riot:${password}`).toString('base64')}`
  };
}

function record(type, details = {}) {
  fs.appendFileSync(outputPath, `${JSON.stringify({ at: new Date().toISOString(), type, ...details })}\n`);
}

function request(endpoint) {
  return new Promise((resolve, reject) => {
    let credentials;
    try { credentials = readCredentials(); }
    catch (error) { reject(error); return; }
    const req = https.request({
      hostname: '127.0.0.1',
      port: credentials.port,
      path: endpoint,
      method: 'GET',
      rejectUnauthorized: false,
      timeout: 5000,
      headers: { Authorization: credentials.auth, Accept: 'application/json' }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GET ${endpoint} failed with ${res.statusCode}`));
          return;
        }
        try { resolve(text ? JSON.parse(text) : null); }
        catch { resolve(text); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`GET ${endpoint} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

const watchedEndpoints = [
  '/lol-settings/v2/account/LCUPreferences/lol-tft',
  '/lol-settings/v2/account/LCUPreferences/lol-skins-viewer',
  '/lol-settings/v2/account/LCUPreferences/lol-collection-champions',
  '/lol-settings/v2/account/LCUPreferences/lol-collection-summoner-icons',
  '/lol-settings/v2/account/LCUPreferences/lol-customizer-icons',
  '/lol-settings/v2/account/LCUPreferences/lol-customizer-titles',
  '/lol-settings/v2/account/LCUPreferences/lol-customizer-tokens',
  '/lol-settings/v2/account/LCUPreferences/cosmetics-last-viewed-date',
  '/lol-settings/v2/account/LCUPreferences/lol-notifications',
  '/lol-settings/v2/account/LCUPreferences/lol-navigation',
  '/lol-settings/v2/account/LCUPreferences/lol-home',
  '/lol-tft-pass/v1/active-passes',
  '/player-notifications/v1/notifications',
  '/lol-regalia/v2/current-summoner/regalia',
  '/lol-gameflow/v1/gameflow-phase'
];
const snapshots = new Map();
const snapshotErrors = new Map();
let polling = false;

async function poll(initial = false) {
  if (polling) return;
  polling = true;
  try {
    await Promise.all(watchedEndpoints.map(async (endpoint) => {
      try {
        const data = await request(endpoint);
        snapshotErrors.delete(endpoint);
        const serialized = JSON.stringify(data);
        const previous = snapshots.get(endpoint);
        if (previous === undefined || previous !== serialized) {
          snapshots.set(endpoint, serialized);
          record(previous === undefined && initial ? 'snapshot-initial' : 'snapshot-change', {
            endpoint,
            before: previous === undefined ? undefined : JSON.parse(previous),
            after: data
          });
        }
      } catch (error) {
        if (snapshotErrors.get(endpoint) !== error.message) {
          snapshotErrors.set(endpoint, error.message);
          record('snapshot-error', { endpoint, message: error.message });
        }
      }
    }));
  } finally {
    polling = false;
  }
}

function clientFrame(opcode, payload = Buffer.alloc(0)) {
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0xfe;
    header.writeUInt16BE(payload.length, 2);
  } else {
    throw new Error('WebSocket payload is too large');
  }
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function sendJson(socket, value) {
  socket.write(clientFrame(1, Buffer.from(JSON.stringify(value))));
}

let buffer = Buffer.alloc(0);
let upgraded = false;
let socket = null;
let reconnectTimer = null;

function processFrames(socket) {
  while (buffer.length >= 2) {
    const opcode = buffer[0] & 0x0f;
    const masked = Boolean(buffer[1] & 0x80);
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return;
      length = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }
    const maskOffset = offset;
    if (masked) offset += 4;
    if (buffer.length < offset + length) return;
    let payload = buffer.subarray(offset, offset + length);
    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }
    buffer = buffer.subarray(offset + length);

    if (opcode === 1) {
      const text = payload.toString('utf8');
      try {
        const message = JSON.parse(text);
        if (message?.[2]?.uri) record('lcu-event', message[2]);
        else record('wamp-message', { message });
      } catch {
        record('websocket-text', { text });
      }
    } else if (opcode === 9) {
      socket.write(clientFrame(10, payload));
    } else if (opcode === 8) {
      record('websocket-close');
      socket.end();
    }
  }
}

await poll(true);

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebsocket();
  }, 1000);
}

function connectWebsocket() {
  let credentials;
  try { credentials = readCredentials(); }
  catch (error) {
    record('websocket-waiting', { message: error.message });
    scheduleReconnect();
    return;
  }

  buffer = Buffer.alloc(0);
  upgraded = false;
  const websocketKey = crypto.randomBytes(16).toString('base64');
  socket = tls.connect({ host: '127.0.0.1', port: credentials.port, rejectUnauthorized: false }, () => {
    socket.write(
      `GET / HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${credentials.port}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${websocketKey}\r\n` +
      'Sec-WebSocket-Version: 13\r\n' +
      'Sec-WebSocket-Protocol: wamp\r\n' +
      `Authorization: ${credentials.auth}\r\n\r\n`
    );
  });

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const responseHeader = buffer.subarray(0, headerEnd).toString('utf8');
      if (!responseHeader.startsWith('HTTP/1.1 101')) {
        record('websocket-error', { message: responseHeader.split('\r\n')[0] });
        socket.destroy();
        return;
      }
      buffer = buffer.subarray(headerEnd + 4);
      upgraded = true;
      sendJson(socket, [5, 'OnJsonApiEvent']);
      record('capture-ready', { pid: process.pid, watchedEndpoints });
    }
    processFrames(socket);
  });

  socket.on('error', (error) => record('websocket-error', { message: error.message }));
  socket.on('close', () => {
    record('websocket-disconnected');
    scheduleReconnect();
  });
}

connectWebsocket();
setInterval(() => { void poll(false); }, 500).unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    record('capture-stopped', { signal });
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.end();
    process.exit(0);
  });
}
