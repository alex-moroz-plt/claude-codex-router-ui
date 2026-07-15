import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ICON_DIR = path.join(ROOT, "public", "icons");
const COLORS = {
  paper: [242, 240, 233, 255],
  ink: [23, 24, 21, 255],
  orange: [236, 100, 56, 255]
};

const GLYPHS = {
  C: ["1111", "1000", "1000", "1000", "1000", "1000", "1111"],
  X: ["1001", "1001", "0110", "0110", "0110", "1001", "1001"]
};

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function createCanvas(size) {
  const pixels = new Uint8Array(size * size * 4);
  for (let index = 0; index < pixels.length; index += 4) pixels.set(COLORS.paper, index);
  return pixels;
}

function setPixel(pixels, size, x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  pixels.set(color, (y * size + x) * 4);
}

function rect(pixels, size, x, y, width, height, color) {
  for (let py = y; py < y + height; py += 1) {
    for (let px = x; px < x + width; px += 1) setPixel(pixels, size, px, py, color);
  }
}

function line(pixels, size, x0, y0, x1, y1, thickness, color) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x0 + ((x1 - x0) * step) / steps);
    const y = Math.round(y0 + ((y1 - y0) * step) / steps);
    rect(pixels, size, x - Math.floor(thickness / 2), y - Math.floor(thickness / 2), thickness, thickness, color);
  }
}

function glyph(pixels, size, letter, x, y, scale, color) {
  GLYPHS[letter].forEach((row, rowIndex) => {
    [...row].forEach((value, colIndex) => {
      if (value === "1") rect(pixels, size, x + colIndex * scale, y + rowIndex * scale, scale, scale, color);
    });
  });
}

function render(size, maskable = false) {
  const pixels = createCanvas(size);
  const unit = size / 192;
  const offset = Math.round((maskable ? 51 : 43) * unit);
  const boxSize = Math.round((maskable ? 90 : 106) * unit);
  const stroke = Math.max(3, Math.round(6 * unit));
  const dot = Math.max(5, Math.round(8 * unit));

  rect(pixels, size, offset, offset, boxSize, stroke, COLORS.ink);
  rect(pixels, size, offset, offset + boxSize - stroke, boxSize, stroke, COLORS.ink);
  rect(pixels, size, offset, offset, stroke, boxSize, COLORS.ink);
  rect(pixels, size, offset + boxSize - stroke, offset, stroke, boxSize, COLORS.ink);
  line(pixels, size, offset + stroke, offset + stroke, offset + boxSize - stroke, offset + boxSize - stroke, stroke, COLORS.ink);

  const glyphScale = Math.max(2, Math.round((maskable ? 3 : 4) * unit));
  const cX = offset + Math.round(14 * unit);
  const cY = offset + Math.round(13 * unit);
  const xX = offset + boxSize - Math.round(35 * unit);
  const xY = offset + boxSize - Math.round(42 * unit);
  const glyphWidth = glyphScale * 4;
  const glyphHeight = glyphScale * 7;
  rect(pixels, size, cX - glyphScale, cY - glyphScale, glyphWidth + glyphScale * 2, glyphHeight + glyphScale * 2, COLORS.paper);
  rect(pixels, size, xX - glyphScale, xY - glyphScale, glyphWidth + glyphScale * 2, glyphHeight + glyphScale * 2, COLORS.paper);
  glyph(pixels, size, "C", cX, cY, glyphScale, COLORS.ink);
  glyph(pixels, size, "X", xX, xY, glyphScale, COLORS.ink);

  const cx = offset + boxSize - Math.round(4 * unit);
  const cy = offset + Math.round(4 * unit);
  for (let y = -dot; y <= dot; y += 1) {
    for (let x = -dot; x <= dot; x += 1) if (x * x + y * y <= dot * dot) setPixel(pixels, size, cx + x, cy + y, COLORS.orange);
  }

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row += 1) {
    const target = row * (size * 4 + 1);
    raw[target] = 0;
    Buffer.from(pixels.buffer, row * size * 4, size * 4).copy(raw, target + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

await mkdir(ICON_DIR, { recursive: true });
await Promise.all([
  writeFile(path.join(ICON_DIR, "icon-192.png"), render(192)),
  writeFile(path.join(ICON_DIR, "icon-512.png"), render(512)),
  writeFile(path.join(ICON_DIR, "maskable-512.png"), render(512, true))
]);
