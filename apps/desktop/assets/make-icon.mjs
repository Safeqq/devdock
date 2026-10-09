// Draws the placeholder DevDock app icon (1024x1024 PNG) without image dependencies:
// a dark rounded square with three teal "dock" bars. Run: node assets/make-icon.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const size = 1024;
const pixels = Buffer.alloc(size * size * 4);

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x >= right || y < top || y >= bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

const bars = [
  { top: 300, width: 520 },
  { top: 470, width: 640 },
  { top: 640, width: 400 },
];
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const offset = (y * size + x) * 4;
    if (!insideRoundedRect(x + 0.5, y + 0.5, 32, 32, 992, 992, 220)) continue;
    let color = [15, 23, 42];
    for (const bar of bars) {
      if (insideRoundedRect(x + 0.5, y + 0.5, 192, bar.top, 192 + bar.width, bar.top + 110, 55)) {
        color = [45, 212, 191];
      }
    }
    pixels.set([...color, 255], offset);
  }
}

const rows = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y += 1) {
  rows[y * (size * 4 + 1)] = 0;
  pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header.set([8, 6, 0, 0, 0], 8);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(rows, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(new URL("./icon-source.png", import.meta.url), png);
