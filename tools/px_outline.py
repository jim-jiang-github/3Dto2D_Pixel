"""Finish a directly-rendered low-res sprite: 1px ink outline, nothing else.

This is the "pixelation, not colour reduction" path: the renderer is already asked
for an N x N image with no anti-aliasing, so every pixel is the real shaded colour
of the surface. The only post step is the contour a sprite needs to read against a
busy background - no palette, no posterize, no dithering.
"""
import os
import json
import argparse

import numpy as np
from PIL import Image

ORDER = ["S", "SW", "W", "NW", "N", "NE", "E", "SE"]


def load(path):
    return np.asarray(Image.open(path).convert("RGBA")).astype(np.float32) / 255.0


def ring(mask):
    pad = np.pad(mask, 1, constant_values=False)
    grow = pad[:-2, 1:-1] | pad[2:, 1:-1] | pad[1:-1, :-2] | pad[1:-1, 2:]
    return grow & ~mask


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("renderdir")
    ap.add_argument("outdir")
    ap.add_argument("--ink", type=str, default="0.10,0.07,0.13")
    ap.add_argument("--no-ink", action="store_true", dest="no_ink")
    ap.add_argument("--zoom", type=int, default=4)
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    names = [d for d in ORDER if os.path.exists(os.path.join(args.renderdir, d + ".png"))]
    if not names:
        raise SystemExit("no renders")

    ink = tuple(float(x) for x in args.ink.split(","))
    frames = {}
    for d in names:
        a = load(os.path.join(args.renderdir, d + ".png"))
        m = a[..., 3] >= 0.5
        a[..., 3] = m.astype(np.float32)
        if not args.no_ink:
            a[ring(m)] = (*ink, 1.0)
        frames[d] = a
        Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), "RGBA").save(
            os.path.join(args.outdir, d + ".png"))

    H, W = frames[names[0]].shape[:2]
    sheet = Image.new("RGBA", (W * len(names), H), (0, 0, 0, 0))
    for i, d in enumerate(names):
        im = Image.fromarray((np.clip(frames[d], 0, 1) * 255).astype(np.uint8), "RGBA")
        sheet.alpha_composite(im, (i * W, 0))
    sheet.save(os.path.join(args.outdir, "sheet.png"))

    z = args.zoom
    prev = sheet.resize((sheet.width * z, sheet.height * z), Image.NEAREST)
    bg = Image.new("RGBA", prev.size, (24, 24, 24, 255))
    bg.alpha_composite(prev)
    bg.convert("RGB").save(os.path.join(args.outdir, "preview_x%d.png" % z))

    with open(os.path.join(args.outdir, "sprite.json"), "w", encoding="utf-8") as f:
        json.dump({"cell_w": W, "cell_h": H, "order": names, "mode": "direct-render"}, f, indent=2)
    print("OK cell=%dx%d frames=%d" % (W, H, len(names)))


main()
