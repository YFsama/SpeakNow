// 生成应用图标：PNG(各尺寸) / icon.ico(Windows) / icon.icns(macOS)
// 纯 Node 实现（SDF 渲染 + 2x 超采样），无第三方依赖
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src-tauri', 'icons');
mkdirSync(outDir, { recursive: true });

// ---------- PNG 编码 ----------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 图标绘制（SDF） ----------
const hex = (c) => [
  parseInt(c.slice(1, 3), 16),
  parseInt(c.slice(3, 5), 16),
  parseInt(c.slice(5, 7), 16),
];
const C0 = hex('#06b6d4'); // 青
const C1 = hex('#4f46e5'); // 靛
const WHITE = [248, 250, 252];
const mix = (a, b, t) => a + (b - a) * t;
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return (
    Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r
  );
}
const BAR_H = [0.55, 1.02, 1.5, 1.02, 0.55];

function renderIcon(size) {
  const ss = 2;
  const n = size * ss;
  const half = n / 2;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = ((x * ss + sx + 0.5) / n) * 2 - 1;
          const v = ((y * ss + sy + 0.5) / n) * 2 - 1;
          // 渐变圆角底
          const bg = sdRoundRect(u, v, 0, 0, 1, 1, 0.225);
          let ca = Math.max(0, Math.min(1, 0.5 - bg * half));
          let cr = 0, cg = 0, cb = 0;
          if (ca > 0) {
            const t = Math.max(0, Math.min(1, (u - v + 2) / 4));
            cr = mix(C0[0], C1[0], t);
            cg = mix(C0[1], C1[1], t);
            cb = mix(C0[2], C1[2], t);
          }
          // 白色声波柱
          for (let i = 0; i < 5; i++) {
            const cx = -0.52 + i * 0.26;
            const sd = sdRoundRect(u, v, cx, 0, 0.08, BAR_H[i] / 2, 0.08);
            const wa = Math.max(0, Math.min(1, 0.5 - sd * half));
            if (wa > 0) {
              const aOut = wa + ca * (1 - wa);
              cr = (WHITE[0] * wa + cr * ca * (1 - wa)) / aOut;
              cg = (WHITE[1] * wa + cg * ca * (1 - wa)) / aOut;
              cb = (WHITE[2] * wa + cb * ca * (1 - wa)) / aOut;
              ca = aOut;
            }
          }
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const q = ss * ss;
      const o = (y * size + x) * 4;
      rgba[o] = Math.round(r / q);
      rgba[o + 1] = Math.round(g / q);
      rgba[o + 2] = Math.round(b / q);
      rgba[o + 3] = Math.round((a / q) * 255);
    }
  }
  return rgba;
}

// ---------- 生成 ----------
const pngs = new Map();
for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  pngs.set(s, encodePng(s, s, renderIcon(s)));
}
const files = {
  '32x32.png': 32,
  '128x128.png': 128,
  '128x128@2x.png': 256,
  'icon.png': 512,
};
for (const [name, s] of Object.entries(files)) {
  writeFileSync(join(outDir, name), pngs.get(s));
}

// ICO（内嵌 PNG 条目）
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(icoSizes.length, 4);
let offset = 6 + 16 * icoSizes.length;
const entries = [];
const blobs = [];
for (const s of icoSizes) {
  const png = pngs.get(s);
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s;
  e[1] = s === 256 ? 0 : s;
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(png.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += png.length;
  entries.push(e);
  blobs.push(png);
}
writeFileSync(join(outDir, 'icon.ico'), Buffer.concat([header, ...entries, ...blobs]));

// ICNS（内嵌 PNG 的各类型条目）
const icnsTypes = [
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
];
const chunks = [];
for (const [t, s] of icnsTypes) {
  const png = pngs.get(s);
  const c = Buffer.alloc(8);
  c.write(t, 0, 'ascii');
  c.writeUInt32BE(png.length + 8, 4);
  chunks.push(c, png);
}
const total = chunks.reduce((n, c) => n + c.length, 0);
const ih = Buffer.alloc(8);
ih.write('icns', 0, 'ascii');
ih.writeUInt32BE(total + 8, 4);
writeFileSync(join(outDir, 'icon.icns'), Buffer.concat([ih, ...chunks]));

console.log(`✓ 图标已生成: ${outDir}`);
