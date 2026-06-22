// Dependency-free icon generator. Draws a hextech-style "swap" icon (two opposing arrows on a
// rounded navy tile with a gold accent) at several sizes, encodes them as PNG (via zlib), and
// wraps a multi-size set into a Windows .ico. Run: node build/generate-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'src', 'assets');
const BUILD = __dirname;

// --- Colors -----------------------------------------------------------------
const NAVY = [22, 30, 46, 255];
const NAVY_EDGE = [38, 50, 74, 255];
const GOLD = [214, 176, 90, 255];
const GOLD_HI = [240, 208, 130, 255];
const TRANSPARENT = [0, 0, 0, 0];

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    Math.round(a[3] + (b[3] - a[3]) * t)
  ];
}

// Signed-distance helpers (positive = inside), sampled 2x2 for cheap anti-aliasing.
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  const outside = Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
  return -outside; // positive inside
}

// Distance to a thick arrow (shaft + head) pointing right (dir=1) or left (dir=-1).
function arrowMask(px, py, x0, x1, cy, half, dir) {
  // Normalize so the arrow always points right, then mirror for left.
  const sx = dir === 1 ? px : (x0 + x1) - px;
  const headStart = x1 - half * 2.0;
  const shaftHalf = half * 0.55;
  if (sx < x0 || sx > x1) return -1;
  if (sx <= headStart) {
    return shaftHalf - Math.abs(py - cy); // shaft
  }
  // triangular head: half-width shrinks linearly to 0 at the tip
  const t = (x1 - sx) / (x1 - headStart);
  return half * t - Math.abs(py - cy);
}

function renderSize(size) {
  const data = Buffer.alloc(size * size * 4);
  const S = size;
  const cx = S / 2;
  const cy = S / 2;
  const tileHalf = S * 0.46;
  const radius = S * 0.22;

  const aUp = { x0: S * 0.20, x1: S * 0.80, cy: S * 0.40, half: S * 0.10, dir: 1 };
  const aDn = { x0: S * 0.20, x1: S * 0.80, cy: S * 0.60, half: S * 0.10, dir: -1 };

  const SS = 2; // supersample factor for AA
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const sample = sampleColor(px, py, S, cx, cy, tileHalf, radius, aUp, aDn);
          r += sample[0] * sample[3];
          g += sample[1] * sample[3];
          b += sample[2] * sample[3];
          a += sample[3];
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const idx = (y * S + x) * 4;
      if (alpha <= 0) {
        data[idx] = 0; data[idx + 1] = 0; data[idx + 2] = 0; data[idx + 3] = 0;
      } else {
        data[idx] = Math.round(r / a);
        data[idx + 1] = Math.round(g / a);
        data[idx + 2] = Math.round(b / a);
        data[idx + 3] = Math.round(alpha);
      }
    }
  }
  return data;
}

function sampleColor(px, py, S, cx, cy, tileHalf, radius, aUp, aDn) {
  const tile = sdRoundRect(px, py, cx, cy, tileHalf, tileHalf, radius);
  if (tile < 0) return TRANSPARENT;
  // arrows (gold), with a vertical highlight gradient
  const up = arrowMask(px, py, aUp.x0, aUp.x1, aUp.cy, aUp.half, aUp.dir);
  const dn = arrowMask(px, py, aDn.x0, aDn.x1, aDn.cy, aDn.half, aDn.dir);
  const arrow = Math.max(up, dn);
  if (arrow > -0.6) {
    const aa = clamp01(arrow + 0.6);
    const grad = clamp01((py / S - 0.25) / 0.5);
    const gold = mix(GOLD_HI, GOLD, grad);
    const bg = tileBg(px, py, S, cx, cy, tileHalf);
    return mix(bg, gold, aa);
  }
  return tileBg(px, py, S, cx, cy, tileHalf);
}

function tileBg(px, py, S, cx, cy, tileHalf) {
  // radial-ish darkening toward edges for depth
  const d = Math.hypot(px - cx, py - cy) / (tileHalf * 1.42);
  return mix(NAVY_EDGE, NAVY, clamp01(1 - d));
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// --- PNG encoding -----------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- ICO encoding (PNG-compressed entries; Windows Vista+) -------------------
function encodeIco(pngsBySize) {
  const entries = pngsBySize;
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  entries.forEach((entry, i) => {
    const base = i * 16;
    dir[base] = entry.size >= 256 ? 0 : entry.size;
    dir[base + 1] = entry.size >= 256 ? 0 : entry.size;
    dir[base + 2] = 0; // palette
    dir[base + 3] = 0;
    dir.writeUInt16LE(1, base + 4); // planes
    dir.writeUInt16LE(32, base + 6); // bpp
    dir.writeUInt32LE(entry.png.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// --- Run --------------------------------------------------------------------
fs.mkdirSync(ASSETS, { recursive: true });
fs.mkdirSync(BUILD, { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = {};
for (const size of sizes) {
  pngs[size] = encodePng(renderSize(size), size);
}

fs.writeFileSync(path.join(ASSETS, 'icon.png'), pngs[256]);
fs.writeFileSync(path.join(ASSETS, 'tray.png'), pngs[32]);
fs.writeFileSync(path.join(ASSETS, 'tray@2x.png'), pngs[64]);
fs.writeFileSync(path.join(BUILD, 'icon.ico'), encodeIco(
  [256, 48, 32, 16].map((size) => ({ size, png: pngs[size] }))
));

console.log('Generated icons:');
console.log(' - src/assets/icon.png (256)');
console.log(' - src/assets/tray.png (32), tray@2x.png (64)');
console.log(' - build/icon.ico (256/48/32/16)');
