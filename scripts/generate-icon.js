#!/usr/bin/env node
// Generates media/icon.png (the extension's marketplace/Extensions-view
// icon) from scratch — a rounded-square indigo-to-cyan gradient with a
// white play-triangle inside a target ring (play = Playwright automation,
// ring = Object Spy's element targeting). No image libraries: this is a
// minimal, from-scratch PNG encoder (raw RGBA scanlines, zlib-deflated via
// Node's built-in zlib, wrapped in standard PNG chunks) so the build has no
// extra dependency just to produce one icon.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256; // marketplace/Extensions-view icons are shown well above 128px on hi-DPI

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = chunk('IHDR', ihdrData);

  // Raw scanlines: each row prefixed with a filter-type byte (0 = None).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = chunk('IDAT', zlib.deflateSync(raw, { level: 9 }));

  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

// ---------------------------------------------------------------------
// Drawing: everything below is plain per-pixel math over an RGBA buffer.
// ---------------------------------------------------------------------

function makeCanvas(size) {
  const buf = Buffer.alloc(size * size * 4);
  return {
    size,
    buf,
    set(x, y, r, g, b, a) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      const i = (y * size + x) * 4;
      // Simple alpha-composite over whatever is already there.
      const srcA = a / 255;
      const dstA = buf[i + 3] / 255;
      const outA = srcA + dstA * (1 - srcA);
      if (outA <= 0) {
        buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0;
        return;
      }
      buf[i] = (r * srcA + buf[i] * dstA * (1 - srcA)) / outA;
      buf[i + 1] = (g * srcA + buf[i + 1] * dstA * (1 - srcA)) / outA;
      buf[i + 2] = (b * srcA + buf[i + 2] * dstA * (1 - srcA)) / outA;
      buf[i + 3] = outA * 255;
    }
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function roundedRectMask(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function antialiasedCoverage(testFn, x, y, samples) {
  // 4x supersampling per pixel for smooth edges without a real rasterizer.
  let hits = 0;
  const step = 1 / samples;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const px = x + (sx + 0.5) * step;
      const py = y + (sy + 0.5) * step;
      if (testFn(px, py)) hits++;
    }
  }
  return hits / (samples * samples);
}

function draw() {
  const size = SIZE;
  const canvas = makeCanvas(size);
  const radius = size * 0.22; // rounded-square corner radius, app-icon-style
  const margin = size * 0.06;

  // Background: diagonal indigo -> cyan gradient, clipped to a rounded square.
  const gradFrom = [79, 70, 229]; // #4F46E5 indigo
  const gradTo = [6, 182, 212]; // #06B6D4 cyan

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const coverage = antialiasedCoverage(
        (px, py) => roundedRectMask(px, py, size, radius) && px >= margin && py >= margin && px <= size - margin && py <= size - margin,
        x,
        y,
        2
      );
      if (coverage <= 0) continue;
      const t = (x + y) / (2 * size); // diagonal gradient position
      const r = lerp(gradFrom[0], gradTo[0], t);
      const g = lerp(gradFrom[1], gradTo[1], t);
      const b = lerp(gradFrom[2], gradTo[2], t);
      canvas.set(x, y, r, g, b, Math.round(255 * coverage));
    }
  }

  // Subtle top-left highlight for depth (soft radial glow), professional
  // "glassy" touch without needing real shadows.
  const glowCx = size * 0.32;
  const glowCy = size * 0.28;
  const glowR = size * 0.42;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!roundedRectMask(x, y, size, radius)) continue;
      const dx = x - glowCx;
      const dy = y - glowCy;
      const d = Math.sqrt(dx * dx + dy * dy) / glowR;
      if (d < 1) {
        const alpha = (1 - d) * 60; // gentle white wash
        canvas.set(x, y, 255, 255, 255, alpha);
      }
    }
  }

  // Target ring (the "spy" element-targeting motif): a white ring, not
  // filled, centered in the icon.
  const cx = size / 2;
  const cy = size / 2;
  const ringOuter = size * 0.335;
  const ringInner = size * 0.28;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const coverage = antialiasedCoverage(
        (px, py) => {
          const dx = px - cx;
          const dy = py - cy;
          const d = Math.sqrt(dx * dx + dy * dy);
          return d <= ringOuter && d >= ringInner;
        },
        x,
        y,
        2
      );
      if (coverage > 0) {
        canvas.set(x, y, 255, 255, 255, Math.round(235 * coverage));
      }
    }
  }

  // Four small corner "reticle" ticks just outside the ring, reinforcing
  // the targeting/crosshair motif at a larger, legible scale.
  const tickLen = size * 0.055;
  const tickThickness = size * 0.018;
  const tickInset = ringOuter + size * 0.02;
  const tickPositions = [
    { dx: -1, dy: -1 },
    { dx: 1, dy: -1 },
    { dx: -1, dy: 1 },
    { dx: 1, dy: 1 }
  ];
  for (const { dx: sx, dy: sy } of tickPositions) {
    const baseX = cx + sx * tickInset * Math.SQRT1_2;
    const baseY = cy + sy * tickInset * Math.SQRT1_2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const rx = x - baseX;
        const ry = y - baseY;
        // A short line segment pointing outward along the diagonal.
        const along = rx * sx + ry * sy;
        const across = rx * sy - ry * sx;
        if (Math.abs(across) <= tickThickness && along >= 0 && along <= tickLen) {
          canvas.set(x, y, 255, 255, 255, 235);
        }
      }
    }
  }

  // Play triangle, centered, pointing right — the Playwright/automation cue.
  const triSize = size * 0.22;
  const triCx = cx + size * 0.012; // optical centering: nudge right slightly
  const triCy = cy;
  const p1 = [triCx - triSize * 0.55, triCy - triSize * 0.65];
  const p2 = [triCx - triSize * 0.55, triCy + triSize * 0.65];
  const p3 = [triCx + triSize * 0.75, triCy];

  function sign(px, py, ax, ay, bx, by) {
    return (px - bx) * (ay - by) - (ax - bx) * (py - by);
  }
  function pointInTriangle(px, py) {
    const d1 = sign(px, py, p1[0], p1[1], p2[0], p2[1]);
    const d2 = sign(px, py, p2[0], p2[1], p3[0], p3[1]);
    const d3 = sign(px, py, p3[0], p3[1], p1[0], p1[1]);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  }

  const triBoundMin = Math.floor(triCx - triSize);
  const triBoundMax = Math.ceil(triCx + triSize);
  for (let y = triBoundMin; y <= triBoundMax; y++) {
    for (let x = triBoundMin; x <= triBoundMax; x++) {
      const coverage = antialiasedCoverage(pointInTriangle, x, y, 3);
      if (coverage > 0) {
        canvas.set(x, y, 17, 24, 39, Math.round(255 * coverage)); // near-black, high contrast on the gradient
      }
    }
  }

  return canvas;
}

const canvas = draw();
const png = encodePng(canvas.size, canvas.size, canvas.buf);
const outPath = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(outPath, png);
console.log(`Wrote ${outPath} (${canvas.size}x${canvas.size})`);
