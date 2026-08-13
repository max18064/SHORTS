import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// These are local, visible editorial cards.  Their IDs are stable so a saved
// campaign can refer to an asset by file name without inventing hidden data.
export const PRESET_OVERLAY_SPECS = Object.freeze([
  Object.freeze({ id: 'emerald', color: '#22C55E' }),
  Object.freeze({ id: 'aqua', color: '#14B8A6' }),
  Object.freeze({ id: 'sky', color: '#38BDF8' }),
  Object.freeze({ id: 'indigo', color: '#6366F1' }),
  Object.freeze({ id: 'violet', color: '#A855F7' }),
  Object.freeze({ id: 'fuchsia', color: '#D946EF' }),
  Object.freeze({ id: 'rose', color: '#F43F5E' }),
  Object.freeze({ id: 'amber', color: '#F59E0B' }),
  Object.freeze({ id: 'orange', color: '#F97316' }),
  Object.freeze({ id: 'lime', color: '#84CC16' }),
]);

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_WIDTH = 640;
const PNG_HEIGHT = 200;
const CARD_LEFT = 32;
const CARD_TOP = 32;
const CARD_WIDTH = PNG_WIDTH - (CARD_LEFT * 2);
const CARD_HEIGHT = PNG_HEIGHT - (CARD_TOP * 2);
const CARD_RADIUS = 20;

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? ((value >>> 1) ^ 0xEDB88320) : (value >>> 1);
  }
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xFFFFFFFF;
  for (const byte of buffer) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xFF];
  return (value ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function parseColor(color) {
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) throw new TypeError('Preset overlay color must be #RRGGBB.');
  return {
    r: Number.parseInt(color.slice(1, 3), 16),
    g: Number.parseInt(color.slice(3, 5), 16),
    b: Number.parseInt(color.slice(5, 7), 16),
  };
}

function isInsideRoundedCard(x, y) {
  if (x < CARD_LEFT || y < CARD_TOP || x >= CARD_LEFT + CARD_WIDTH || y >= CARD_TOP + CARD_HEIGHT) return false;
  const nearestX = Math.max(CARD_LEFT + CARD_RADIUS, Math.min(x, CARD_LEFT + CARD_WIDTH - CARD_RADIUS - 1));
  const nearestY = Math.max(CARD_TOP + CARD_RADIUS, Math.min(y, CARD_TOP + CARD_HEIGHT - CARD_RADIUS - 1));
  const deltaX = x - nearestX;
  const deltaY = y - nearestY;
  return (deltaX * deltaX) + (deltaY * deltaY) <= CARD_RADIUS * CARD_RADIUS;
}

function isCardEdge(x, y) {
  return isInsideRoundedCard(x, y)
    && (!isInsideRoundedCard(x - 1, y)
      || !isInsideRoundedCard(x + 1, y)
      || !isInsideRoundedCard(x, y - 1)
      || !isInsideRoundedCard(x, y + 1));
}

function renderRgba(color) {
  const rgb = parseColor(color);
  const rowSize = 1 + (PNG_WIDTH * 4);
  const pixels = Buffer.alloc(rowSize * PNG_HEIGHT);
  for (let y = 0; y < PNG_HEIGHT; y += 1) {
    const rowOffset = y * rowSize;
    pixels[rowOffset] = 0; // PNG filter type: none.
    for (let x = 0; x < PNG_WIDTH; x += 1) {
      if (!isInsideRoundedCard(x, y)) continue; // Transparent canvas around the card.
      const pixelOffset = rowOffset + 1 + (x * 4);
      const horizontal = (x - CARD_LEFT) / Math.max(1, CARD_WIDTH - 1);
      const vertical = (y - CARD_TOP) / Math.max(1, CARD_HEIGHT - 1);
      const highlight = Math.round(24 * horizontal - 12 * vertical);
      const edge = isCardEdge(x, y);
      pixels[pixelOffset] = Math.max(0, Math.min(255, rgb.r + highlight + (edge ? 18 : 0)));
      pixels[pixelOffset + 1] = Math.max(0, Math.min(255, rgb.g + highlight + (edge ? 18 : 0)));
      pixels[pixelOffset + 2] = Math.max(0, Math.min(255, rgb.b + highlight + (edge ? 18 : 0)));
      pixels[pixelOffset + 3] = edge ? 245 : 214;
    }
  }
  return pixels;
}

function createRgbaPng(color) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(PNG_WIDTH, 0);
  ihdr.writeUInt32BE(PNG_HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA color type
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace
  const idat = zlib.deflateSync(renderRgba(color), { level: 9 });
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

function hasExpectedRgbaIhdr(filePath) {
  let content;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    content = fs.readFileSync(filePath);
  } catch {
    return false;
  }
  if (content.length < PNG_SIGNATURE.length + 25 || !content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return false;
  if (content.readUInt32BE(8) !== 13 || content.subarray(12, 16).toString('ascii') !== 'IHDR') return false;
  return content.readUInt32BE(16) === PNG_WIDTH
    && content.readUInt32BE(20) === PNG_HEIGHT
    && content[24] === 8
    && content[25] === 6
    && content[26] === 0
    && content[27] === 0
    && content[28] === 0;
}

function normalizedDirectory(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('directory must be a non-empty path.');
  }
  return path.resolve(value);
}

function writeAssetIfNeeded(filePath, color) {
  if (hasExpectedRgbaIhdr(filePath)) return;
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, createRgbaPng(color), { flag: 'wx' });
    // Do not replace a valid asset another process may have completed while
    // this one was rendering its temporary file.
    if (!hasExpectedRgbaIhdr(filePath)) fs.renameSync(temporaryPath, filePath);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch { /* File was renamed or never created. */ }
  }
}

/**
 * Ensure all local preset overlay assets exist.  Files that already have the
 * expected PNG signature and RGBA IHDR are left untouched; missing or invalid
 * assets are regenerated deterministically.  The result is absolute paths in
 * the same order as PRESET_OVERLAY_SPECS.
 */
export function ensurePresetOverlayAssets({ directory } = {}) {
  const outputDirectory = normalizedDirectory(directory);
  fs.mkdirSync(outputDirectory, { recursive: true });
  return PRESET_OVERLAY_SPECS.map(spec => {
    const assetPath = path.join(outputDirectory, `${spec.id}.png`);
    writeAssetIfNeeded(assetPath, spec.color);
    return assetPath;
  });
}
