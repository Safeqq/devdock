// Draws the DevDock app icon (1024x1024 PNG) without image dependencies. It repeats the logo in
// the app's sidebar: an ink-framed sheet of cream paper with three ink "dock" bars, in the UI's
// paper (#f4f1e9) and ink (#16140f) colours. Run: node assets/make-icon.mjs, then
// npx tauri icon apps/desktop/assets/icon-source.png -o apps/desktop/src-tauri/icons
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const size = 1024;
const pixels = Buffer.alloc(size * size * 4);
const paper = [244, 241, 233];
const ink = [22, 20, 15];

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x >= right || y < top || y >= bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

// Square bar ends, as in the UI; widths follow the sidebar logo (70%, full, 55%).
const bars = [
  { top: 300, width: 392 },
  { top: 460, width: 560 },
  { top: 620, width: 308 },
];
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const offset = (y * size + x) * 4;
    const px = x + 0.5;
    const py = y + 0.5;
    if (!insideRoundedRect(px, py, 32, 32, 992, 992, 120)) continue;
    let color = ink;
    if (insideRoundedRect(px, py, 96, 96, 928, 928, 64)) {
      color = paper;
      for (const bar of bars) {
        if (px >= 232 && px < 232 + bar.width && py >= bar.top && py < bar.top + 104) color = ink;
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
