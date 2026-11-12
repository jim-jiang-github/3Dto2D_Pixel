/**
 * The pixelation step. Geometry (block grid) and colour (palette) are separate
 * concerns: this file only decides which real colour each block keeps. It never
 * invents a mean of two neighbouring blocks and never reduces the palette, so a
 * suit of armour keeps its shading ramp instead of collapsing into 16 tones.
 *
 * Why vote instead of average: averaging a high-res render mixes robe purple
 * with skin and turns everything muddy. Voting lets the block keep the colour of
 * its dominant group of sub-pixels - a colour that genuinely exists on the
 * model - and lets stray sub-pixels lose the election instead of smearing.
 */

const ORDER = ["S", "SW", "W", "NW", "N", "NE", "E", "SE"];
const ORDER_CN = { S: "正面", SW: "左前", W: "左侧", NW: "左后", N: "背面", NE: "右后", E: "右侧", SE: "右前" };

/**
 * @param {Uint8Array} px  RGBA bytes, W x W, sRGB
 * @param {number} W       source width (square)
 * @param {number} size    target grid size
 * @param {number} levels  per-channel buckets used ONLY for the vote
 * @param {number} cover   minimum opaque fraction for a block to survive
 * @param {boolean} flipY  WebGL framebuffers start at the bottom row
 */
export function voteDownscale(px, W, size, levels = 8, cover = 0.3, flipY = false) {
  const f = Math.floor(W / size);
  if (f * size !== W) throw new Error("supersample is not an integer multiple of the grid");

  const out = new Uint8ClampedArray(size * size * 4);
  const shift = Math.round(Math.log2(256 / levels)); // 8 levels -> 5
  const buckets = levels * levels * levels;
  const counts = new Uint16Array(buckets);
  const sumR = new Uint32Array(buckets);
  const sumG = new Uint32Array(buckets);
  const sumB = new Uint32Array(buckets);
  const touched = new Int32Array(buckets);
  const needed = cover * f * f;

  for (let by = 0; by < size; by++) {
    for (let bx = 0; bx < size; bx++) {
      let nTouched = 0;
      let opaque = 0;

      for (let yy = 0; yy < f; yy++) {
        const y = by * f + yy;
        const srcY = flipY ? W - 1 - y : y;
        let i = (srcY * W + bx * f) * 4;
        for (let x = 0; x < f; x++, i += 4) {
          if (px[i + 3] < 128) continue;
          opaque++;
          const key =
            ((px[i] >> shift) * levels + (px[i + 1] >> shift)) * levels + (px[i + 2] >> shift);
          if (counts[key] === 0) touched[nTouched++] = key;
          counts[key]++;
          sumR[key] += px[i];
          sumG[key] += px[i + 1];
          sumB[key] += px[i + 2];
        }
      }

      const o = (by * size + bx) * 4;
      if (opaque >= needed && opaque > 0) {
        let best = -1;
        let bestN = 0;
        for (let k = 0; k < nTouched; k++) {
          const key = touched[k];
          if (counts[key] > bestN) { bestN = counts[key]; best = key; }
        }
        if (best >= 0) {
          out[o] = sumR[best] / bestN;
          out[o + 1] = sumG[best] / bestN;
          out[o + 2] = sumB[best] / bestN;
          out[o + 3] = 255;
        }
      }

      for (let k = 0; k < nTouched; k++) {
        const key = touched[k];
        counts[key] = 0; sumR[key] = 0; sumG[key] = 0; sumB[key] = 0;
      }
    }
  }
  return out;
}

/** 1px ink ring OUTSIDE the silhouette. Never touches pixels inside the body. */
export function inkOutline(rgba, size, rgb = [0, 0, 0]) {
  const mask = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) mask[i] = rgba[i * 4 + 3] >= 128 ? 1 : 0;

  const out = new Uint8ClampedArray(rgba);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (mask[i]) continue;
      const up = y > 0 && mask[i - size];
      const dn = y < size - 1 && mask[i + size];
      const lf = x > 0 && mask[i - 1];
      const rt = x < size - 1 && mask[i + 1];
      if (up || dn || lf || rt) {
        out[i * 4] = rgb[0];
        out[i * 4 + 1] = rgb[1];
        out[i * 4 + 2] = rgb[2];
        out[i * 4 + 3] = 255;
      }
    }
  }
  return out;
}

/** Put the grid onto a canvas, scaled by an integer factor (NEAREST). */
export function toCanvas(rgba, size, zoom = 4) {
  const src = document.createElement("canvas");
  src.width = size;
  src.height = size;
  const sctx = src.getContext("2d");
  sctx.putImageData(new ImageData(rgba, size, size), 0, 0);

  const dst = document.createElement("canvas");
  dst.width = size * zoom;
  dst.height = size * zoom;
  const dctx = dst.getContext("2d");
  dctx.imageSmoothingEnabled = false;
  dctx.drawImage(src, 0, 0, dst.width, dst.height);
  return dst;
}

/** 4 x 2 atlas: S SW W NW on the top row, N NE E SE on the bottom. */
export function makeSheet(frames, size) {
  const c = document.createElement("canvas");
  c.width = size * 4;
  c.height = size * 2;
  const ctx = c.getContext("2d");
  ORDER.forEach((dir, i) => {
    const f = frames[dir];
    if (!f) return;
    const tmp = document.createElement("canvas");
    tmp.width = size;
    tmp.height = size;
    tmp.getContext("2d").putImageData(new ImageData(f, size, size), 0, 0);
    ctx.drawImage(tmp, (i % 4) * size, Math.floor(i / 4) * size);
  });
  return c;
}

export function downloadCanvas(canvas, name) {
  canvas.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, "image/png");
}

export { ORDER, ORDER_CN };
