/**
 * Minimal GIF89a encoder - no dependencies, no worker, no CDN.
 *
 * Why hand-rolled: the same reason as zip.js. Bundled UMD builds of gif.js /
 * jszip come back as an empty module when imported with a native ES `import()`,
 * and pulling a CDN into a local-only tool is worse than 200 lines of LZW.
 *
 * GIF has a hard 256-colour limit per frame, so each frame gets its own local
 * colour table produced by weighted median cut. No dithering: dithering would
 * scatter single pixels and destroy the whole point of the pixel grid.
 */

const TRANSPARENT_ALPHA = 128;

/* ------------------------------------------------------------------ */
/* colour quantisation                                                 */
/* ------------------------------------------------------------------ */

/**
 * Weighted median cut. Splits the box with the most pixels along its longest
 * axis until we have `limit` boxes, then averages each box.
 * @param {{r:number,g:number,b:number,n:number}[]} colors
 * @param {number} limit
 */
function medianCut(colors, limit) {
  const makeBox = (items) => {
    let total = 0;
    for (const c of items) total += c.n;
    return { items, total };
  };

  const boxes = [makeBox(colors)];
  while (boxes.length < limit) {
    let pick = -1;
    let best = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].items.length < 2) continue;
      if (boxes[i].total > best) { best = boxes[i].total; pick = i; }
    }
    if (pick < 0) break;

    const box = boxes[pick];
    let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
    for (const c of box.items) {
      if (c.r < rMin) rMin = c.r;
      if (c.r > rMax) rMax = c.r;
      if (c.g < gMin) gMin = c.g;
      if (c.g > gMax) gMax = c.g;
      if (c.b < bMin) bMin = c.b;
      if (c.b > bMax) bMax = c.b;
    }
    const dr = rMax - rMin;
    const dg = gMax - gMin;
    const db = bMax - bMin;
    const axis = dr >= dg && dr >= db ? "r" : dg >= db ? "g" : "b";

    box.items.sort((a, b) => a[axis] - b[axis]);

    let acc = 0;
    let split = 1;
    const half = box.total / 2;
    for (let i = 0; i < box.items.length - 1; i++) {
      acc += box.items[i].n;
      if (acc >= half) { split = i + 1; break; }
    }
    boxes.splice(
      pick, 1,
      makeBox(box.items.slice(0, split)),
      makeBox(box.items.slice(split)),
    );
  }

  return boxes.map((box) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (const c of box.items) {
      r += c.r * c.n;
      g += c.g * c.n;
      b += c.b * c.n;
      n += c.n;
    }
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
  });
}

/**
 * Build a local colour table + index buffer for one frame.
 * One slot is reserved for transparency.
 */
function quantizeFrame(rgba, pixelCount, colorLimit) {
  const counts = new Map();
  for (let i = 0, p = 0; i < pixelCount; i++, p += 4) {
    if (rgba[p + 3] < TRANSPARENT_ALPHA) continue;
    const key = (rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  // Fully transparent frame: a 1-entry table is still needed to stay legal.
  if (counts.size === 0) {
    return {
      indices: new Uint8Array(pixelCount),
      palette: new Uint8Array([0, 0, 0]),
      tableSize: 2,
      transparentIndex: 0,
    };
  }

  const exact = counts.size <= colorLimit;
  let palette;
  const lookup = new Map();

  if (exact) {
    palette = [];
    for (const key of counts.keys()) {
      palette.push({ r: (key >> 16) & 255, g: (key >> 8) & 255, b: key & 255 });
    }
  } else {
    const colors = [];
    for (const [key, n] of counts) {
      colors.push({ r: (key >> 16) & 255, g: (key >> 8) & 255, b: key & 255, n });
    }
    palette = medianCut(colors, colorLimit);
  }

  // Map every source colour to its palette slot.
  if (exact) {
    let i = 0;
    for (const key of counts.keys()) lookup.set(key, i++);
  } else {
    for (const key of counts.keys()) {
      const r = (key >> 16) & 255;
      const g = (key >> 8) & 255;
      const b = key & 255;
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < palette.length; i++) {
        const p = palette[i];
        // Weighted RGB distance: the eye is most sensitive to green, then red.
        const dr = r - p.r, dg = g - p.g, db = b - p.b;
        const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
        if (d < bestD) { bestD = d; best = i; }
      }
      lookup.set(key, best);
    }
  }

  const transparentIndex = palette.length;
  let tableSize = 2;
  while (tableSize < palette.length + 1) tableSize <<= 1;
  if (tableSize > 256) tableSize = 256;

  const table = new Uint8Array(tableSize * 3);
  for (let i = 0; i < palette.length; i++) {
    table[i * 3] = palette[i].r;
    table[i * 3 + 1] = palette[i].g;
    table[i * 3 + 2] = palette[i].b;
  }

  const indices = new Uint8Array(pixelCount);
  for (let i = 0, p = 0; i < pixelCount; i++, p += 4) {
    if (rgba[p + 3] < TRANSPARENT_ALPHA) {
      indices[i] = transparentIndex;
      continue;
    }
    const key = (rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2];
    indices[i] = lookup.get(key);
  }

  return { indices, palette: table, tableSize, transparentIndex };
}

/* ------------------------------------------------------------------ */
/* LZW                                                                 */
/* ------------------------------------------------------------------ */

function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  let codeSize = minCodeSize + 1;
  let next = endCode + 1;
  const dict = new Map();

  const out = [];
  let bitBuf = 0;
  let bitCount = 0;

  const emit = (code) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuf & 255);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };

  emit(clearCode);

  if (indices.length === 0) {
    emit(endCode);
    if (bitCount > 0) out.push(bitBuf & 255);
    return out;
  }

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i];
    const key = (prefix << 8) | c;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      // The decoder only adds this entry after it reads the next code, so its
      // table always trails ours by one. Widen one code later than the table
      // size would suggest, or the two sides desync and every subsequent code
      // decodes into noise.
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(clearCode);
      dict.clear();
      next = endCode + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = c;
  }

  emit(prefix);
  emit(endCode);
  if (bitCount > 0) out.push(bitBuf & 255);
  return out;
}

/* ------------------------------------------------------------------ */
/* container                                                           */
/* ------------------------------------------------------------------ */

/**
 * @param {Uint8ClampedArray[]} frames  RGBA, all `width*height*4`
 * @param {object} opts
 * @param {number} opts.width   grid width (before zoom)
 * @param {number} opts.height  grid height (before zoom)
 * @param {number} [opts.zoom]  integer nearest-neighbour scale
 * @param {number} [opts.delay] ms per frame
 * @param {number} [opts.loop]  0 = forever
 * @param {number} [opts.maxColors] 2..256
 * @returns {Uint8Array}
 */
export function encodeGif(frames, opts) {
  const {
    width, height, zoom = 4, delay = 140, loop = 0, maxColors = 256,
  } = opts;

  const cw = width * zoom;
  const ch = height * zoom;
  const colorLimit = Math.min(255, Math.max(1, maxColors - 1));

  const out = [];
  const u8 = (v) => out.push(v & 255);
  const u16 = (v) => { out.push(v & 255, (v >> 8) & 255); };
  const str = (s) => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };

  // --- header ---
  str("GIF89a");
  u16(cw);
  u16(ch);
  u8(0x70);   // no global colour table, 8-bit colour resolution
  u8(0);      // background colour index
  u8(0);      // pixel aspect ratio

  // --- loop extension ---
  u8(0x21); u8(0xff); u8(0x0b);
  str("NETSCAPE2.0");
  u8(0x03); u8(0x01); u16(loop); u8(0x00);

  const delayCs = Math.max(2, Math.round(delay / 10));

  for (const frame of frames) {
    const { indices, palette, tableSize, transparentIndex } =
      quantizeFrame(frame, width * height, colorLimit);

    // --- graphic control: dispose to background so frames never ghost ---
    u8(0x21); u8(0xf9); u8(0x04);
    u8((2 << 2) | 1);           // disposal 2, transparency on
    u16(delayCs);
    u8(transparentIndex);
    u8(0x00);

    // --- image descriptor ---
    u8(0x2c);
    u16(0); u16(0);
    u16(cw); u16(ch);
    let sizeBits = 0;
    while (1 << (sizeBits + 1) < tableSize) sizeBits++;
    u8(0x80 | sizeBits);        // local colour table present

    for (let i = 0; i < tableSize * 3; i++) out.push(palette[i]);

    // --- pixel data, nearest-neighbour expanded to `zoom` ---
    let pixels = indices;
    if (zoom !== 1) {
      pixels = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) {
        const sy = (y / zoom) | 0;
        const row = sy * width;
        const dst = y * cw;
        for (let x = 0; x < cw; x++) {
          pixels[dst + x] = indices[row + ((x / zoom) | 0)];
        }
      }
    }

    const minCodeSize = Math.max(2, sizeBits + 1);
    const data = lzwEncode(pixels, minCodeSize);
    u8(minCodeSize);
    for (let i = 0; i < data.length; i += 255) {
      const n = Math.min(255, data.length - i);
      u8(n);
      for (let j = 0; j < n; j++) out.push(data[i + j]);
    }
    u8(0x00);                   // block terminator
  }

  u8(0x3b);                     // trailer
  return Uint8Array.from(out);
}
