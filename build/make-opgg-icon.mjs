// Fetch OP.GG's app icon and make a monochrome toolbar icon the same way as the Porofessor one:
// drop the (blue) background tile and desaturate, leaving the white "OP.GG" wordmark on transparent.
// Writes src/renderer/opgg.png. Run: node build/make-opgg-icon.mjs
import https from 'node:https';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = 'https://c-lol-web.op.gg/app-router/assets/images/meta/Icon-144.png';

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchBuffer(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function decodePng(buf) {
  let off = 8;
  let width, height, bitDepth, colorType;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error(`unsupported color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const rowIn = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const v = raw[rowIn + x];
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = (x >= channels && y > 0) ? out[(y - 1) * stride + x - channels] : 0;
      let val;
      switch (ft) {
        case 0: val = v; break;
        case 1: val = v + a; break;
        case 2: val = v + b; break;
        case 3: val = v + ((a + b) >> 1); break;
        case 4: val = v + paeth(a, b, c); break;
        default: throw new Error(`unsupported filter ${ft}`);
      }
      out[y * stride + x] = val & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) { const t = Buffer.from(type, 'ascii'); const body = Buffer.concat([t, data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0); return Buffer.concat([len, body, crc]); }
function encodePng(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = size * 4;
  const rawData = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) { rawData[y * (stride + 1)] = 0; rgba.copy(rawData, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(rawData, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- Run --------------------------------------------------------------------
const png = await fetchBuffer(SRC);
const { width, height, channels, data } = decodePng(png);
const at = (x, y, k) => data[(y * width + x) * channels + k];

const rgba = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const r = at(x, y, 0), g = at(x, y, 1), b = at(x, y, 2);
    const srcA = channels === 4 ? at(x, y, 3) : 255;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    // Keep the bright wordmark, drop the mid-luminance blue tile; respect the source rounded corners.
    let alpha = Math.max(0, Math.min(255, Math.round(((lum - 150) / (215 - 150)) * 255)));
    alpha = Math.round(alpha * (srcA / 255));
    const gray = Math.round(lum);
    const o = (y * width + x) * 4;
    rgba[o] = gray; rgba[o + 1] = gray; rgba[o + 2] = gray; rgba[o + 3] = alpha;
  }
}

const outPng = encodePng(rgba, width);
fs.writeFileSync(path.join(ROOT, 'src', 'renderer', 'opgg.png'), outPng);
console.log(`src/renderer/opgg.png written (${width}x${height}, ${outPng.length}B)`);
