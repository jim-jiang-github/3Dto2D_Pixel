"""Supersample a big un-antialiased render down to the sprite grid by DECISION, not averaging.

Why this exists: rendering straight at 84x84 gives one ray per block, so a feature
thinner than a block either vanishes or fires a stray pixel - that stray pixel is
what the eye reads as "dirty / not clear". Averaging a big render instead mixes
robe purple with skin and turns everything muddy, which is the failure mode we
already rejected.

So: render big with taa=1 (every sub-pixel is a real shaded colour, no AA), then
for each target block vote on colour. The block keeps the colour of its dominant
group of sub-pixels, which is always a colour that actually appears on the model -
no invented in-between tones, and stray sub-pixels lose the vote instead of
smearing.
"""
import os
import argparse

import numpy as np
from PIL import Image

ORDER = ["S", "SW", "W", "NW", "N", "NE", "E", "SE"]


def load(path):
    return np.asarray(Image.open(path).convert("RGBA")).astype(np.float32) / 255.0


def vote_block(block, alpha, levels):
    """block: (n, 3) colours of the opaque sub-pixels. Returns the mean colour of
    the largest quantised group, or None if too little coverage."""
    if block.shape[0] == 0:
        return None
    q = np.clip(np.round(block * (levels - 1)), 0, levels - 1).astype(np.int32)
    key = (q[:, 0] * levels + q[:, 1]) * levels + q[:, 2]
    vals, cnt = np.unique(key, return_counts=True)
    win = vals[cnt.argmax()]
    sel = key == win
    col = block[sel].mean(0)
    return col


def down(hi, size, levels, cover):
    H, W = hi.shape[:2]
    f = H // size
    if f * size != H:
        raise SystemExit("supersample %d is not an integer multiple of %d" % (H, size))
    a = hi[..., 3]
    rgb = hi[..., :3]
    out = np.zeros((size, size, 4), dtype=np.float32)
    for by in range(size):
        for bx in range(size):
            sub = rgb[by * f:(by + 1) * f, bx * f:(bx + 1) * f].reshape(-1, 3)
            sa = a[by * f:(by + 1) * f, bx * f:(bx + 1) * f].reshape(-1)
            keep = sa >= 0.5
            if keep.mean() < cover:
                continue
            col = vote_block(sub[keep], keep, levels)
            if col is None:
                continue
            out[by, bx, :3] = col
            out[by, bx, 3] = 1.0
    return out


def ring(mask):
    pad = np.pad(mask, 1, constant_values=False)
    grow = pad[:-2, 1:-1] | pad[2:, 1:-1] | pad[1:-1, :-2] | pad[1:-1, 2:]
    return grow & ~mask


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("hidir")
    ap.add_argument("outdir")
    ap.add_argument("--size", type=int, default=84)
    ap.add_argument("--levels", type=int, default=12,
                    help="per-channel buckets used only for the vote")
    ap.add_argument("--cover", type=float, default=0.45)
    ap.add_argument("--ink", type=str, default="0,0,0")
    ap.add_argument("--no-ink", action="store_true", dest="no_ink")
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    names = [d for d in ORDER if os.path.exists(os.path.join(args.hidir, d + ".png"))]
    if not names:
        raise SystemExit("no renders")
    ink = tuple(float(x) for x in args.ink.split(","))

    frames = {}
    for d in names:
        hi = load(os.path.join(args.hidir, d + ".png"))
        out = down(hi, args.size, args.levels, args.cover)
        m = out[..., 3] > 0.5
        if not args.no_ink:
            out[ring(m)] = (*ink, 1.0)
        frames[d] = out
        Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8), "RGBA").save(
            os.path.join(args.outdir, d + ".png"))

    sheet = Image.new("RGBA", (args.size * len(names), args.size), (0, 0, 0, 0))
    for i, d in enumerate(names):
        sheet.alpha_composite(
            Image.fromarray((np.clip(frames[d], 0, 1) * 255).astype(np.uint8), "RGBA"),
            (i * args.size, 0))
    sheet.save(os.path.join(args.outdir, "sheet.png"))
    print("OK cell=%d frames=%d" % (args.size, len(names)))


main()
