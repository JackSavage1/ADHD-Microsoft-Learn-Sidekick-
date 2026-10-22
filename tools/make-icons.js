// Sidekick icon generator.
//
// Usage (from the repo root):
//   node tools/make-icons.js
//
// Writes icons/icon16.png, icon32.png, icon48.png and icon128.png.
//
// The design is a deep-teal rounded square with a bold white check mark: calm
// colors, one simple shape, readable even at 16 x 16 in Chrome's toolbar.
// The check mark is a nod to the small, satisfying "done!" moments Sidekick is
// built around.
//
// This script uses only Node's built-in modules (no npm packages). It draws
// every pixel itself and writes the PNG file format by hand, so it is also a
// small, readable example of how a PNG file is put together.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// 1. The design, described in "unit" coordinates.
//    (0, 0) is the top-left corner of the icon and (1, 1) is the bottom-right,
//    so the same description works at every size.
// ---------------------------------------------------------------------------

const SIZES = [16, 32, 48, 128];

// Transparent gap between the rounded square and the edge of the image.
// 1/16 of the size: exactly 1 px at 16 px, 8 px at 128 px.
const MARGIN = 1 / 16;

// How round the square's corners are (as a fraction of the icon size).
const CORNER_RADIUS = 0.22;

// A gentle top-to-bottom gradient gives the square a little depth.
// Both shades are dark enough for white to stand out clearly on top.
const TOP_COLOR = { r: 0x0f, g: 0x85, b: 0x7c }; // deep teal
const BOTTOM_COLOR = { r: 0x0b, g: 0x5c, b: 0x56 }; // deeper teal
const GLYPH_COLOR = { r: 0xff, g: 0xff, b: 0xff }; // white

// The check mark is two thick line segments joined at the bottom point.
// Drawing them with round ends gives smooth caps and a smooth corner for free.
const CHECK_POINTS = [
  { x: 0.27, y: 0.52 }, // start of the short stroke (left)
  { x: 0.43, y: 0.68 }, // bottom of the "V"
  { x: 0.74, y: 0.35 }, // end of the long stroke (top right)
];
const CHECK_HALF_WIDTH = 0.08; // half the stroke thickness

// Antialiasing: each output pixel is split into a SUPERSAMPLE x SUPERSAMPLE
// grid of tiny sample points. The pixel's final color is the average of all
// the samples, which turns jagged edges into smooth ones.
const SUPERSAMPLE = 4;

// ---------------------------------------------------------------------------
// 2. Geometry helpers: "is this point inside the shape?"
// ---------------------------------------------------------------------------

// Signed distance from point (x, y) to a rounded square centered in the icon.
// Negative means inside, positive means outside.
function roundedSquareDistance(x, y) {
  const halfSize = 0.5 - MARGIN;
  // Fold the point into the top-right quarter (the shape is symmetric).
  const qx = Math.abs(x - 0.5) - (halfSize - CORNER_RADIUS);
  const qy = Math.abs(y - 0.5) - (halfSize - CORNER_RADIUS);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - CORNER_RADIUS;
}

// Distance from point P to the line segment A-B.
function distanceToSegment(px, py, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  // How far along A-B the closest point is (0 = at A, 1 = at B).
  let t = ((px - a.x) * abx + (py - a.y) * aby) / (abx * abx + aby * aby);
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * abx), py - (a.y + t * aby));
}

function isInsideCheckMark(x, y) {
  for (let i = 0; i < CHECK_POINTS.length - 1; i++) {
    if (distanceToSegment(x, y, CHECK_POINTS[i], CHECK_POINTS[i + 1]) <= CHECK_HALF_WIDTH) {
      return true;
    }
  }
  return false;
}

// The color (and opacity) of one sample point.
function sampleColor(x, y) {
  if (roundedSquareDistance(x, y) > 0) {
    return { r: 0, g: 0, b: 0, a: 0 }; // outside the square: fully transparent
  }
  if (isInsideCheckMark(x, y)) {
    return { ...GLYPH_COLOR, a: 1 };
  }
  // Blend the two background shades depending on how far down we are.
  const t = Math.max(0, Math.min(1, (y - MARGIN) / (1 - 2 * MARGIN)));
  return {
    r: TOP_COLOR.r + (BOTTOM_COLOR.r - TOP_COLOR.r) * t,
    g: TOP_COLOR.g + (BOTTOM_COLOR.g - TOP_COLOR.g) * t,
    b: TOP_COLOR.b + (BOTTOM_COLOR.b - TOP_COLOR.b) * t,
    a: 1,
  };
}

// ---------------------------------------------------------------------------
// 3. Draw the icon into a raw RGBA pixel buffer (4 bytes per pixel).
// ---------------------------------------------------------------------------

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samplesPerPixel = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Add up the samples. Colors are weighted by their opacity
      // ("premultiplied"), so transparent samples don't darken the edges.
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          const c = sampleColor(x, y);
          sumR += c.r * c.a;
          sumG += c.g * c.a;
          sumB += c.b * c.a;
          sumA += c.a;
        }
      }

      const offset = (py * size + px) * 4;
      if (sumA > 0) {
        pixels[offset] = Math.round(sumR / sumA);
        pixels[offset + 1] = Math.round(sumG / sumA);
        pixels[offset + 2] = Math.round(sumB / sumA);
        pixels[offset + 3] = Math.round((sumA / samplesPerPixel) * 255);
      }
      // else: leave all four bytes at 0 (transparent).
    }
  }
  return pixels;
}

// ---------------------------------------------------------------------------
// 4. Write the pixels as a PNG file.
//
// A PNG file is an 8-byte signature followed by "chunks". Each chunk is:
//   4 bytes  length of the data (big-endian)
//   4 bytes  chunk type, e.g. "IHDR"
//   N bytes  the data
//   4 bytes  CRC-32 checksum of the type + data
// We need three chunk types: IHDR (header), IDAT (pixels), IEND (end).
// ---------------------------------------------------------------------------

// CRC-32 lookup table (the standard polynomial used by PNG, zip and gzip).
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR: width, height, bit depth 8, color type 6 (RGBA),
  // compression 0, filter method 0, no interlacing.
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  // IDAT: every row of pixels starts with a "filter type" byte.
  // 0 means "no filter": the row's bytes are stored as-is.
  const rowLength = size * 4;
  const raw = Buffer.alloc((rowLength + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (rowLength + 1)] = 0;
    rgba.copy(raw, y * (rowLength + 1) + 1, y * rowLength, (y + 1) * rowLength);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    makeChunk('IHDR', header),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 5. Generate every size.
// ---------------------------------------------------------------------------

const outputDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outputDir, { recursive: true });

for (const size of SIZES) {
  const file = path.join(outputDir, `icon${size}.png`);
  fs.writeFileSync(file, encodePng(size, renderIcon(size)));
  console.log(`Wrote ${path.relative(process.cwd(), file)} (${size}x${size})`);
}
