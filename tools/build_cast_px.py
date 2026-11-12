"""Build pixel sprite sets from GLB models in one command.

The whole recipe, in order:

  1. render every facing at a high resolution with anti-aliasing OFF, so each
     sub-pixel is a real shaded colour (no AA blend with the transparent bg);
  2. vote on colour per target block (tools/px_ssaa.py) - the block keeps the
     dominant group's mean, so no invented in-between tones appear;
  3. draw a 1px ink ring OUTSIDE the silhouette (nothing inside the body);
  4. write sprite.json / sheet / preview / 2x / 4x2 atlas.

Why the supersample matters: one ray per block makes a feature thinner than a
block either vanish or fire a stray pixel, which reads as "dirty". Rendering
big and voting fixes that without averaging colours together.

The target size must divide the supersample exactly. 1440 gives 72 (20 sub-px),
80 (18), 90 (16), 96 (15), 120 (12), 144 (10); 90 is the tuned default - blocks
are visibly pixel-art, faces still read.

    python tools/build_cast_px.py --glb-dir assets/characters
    python tools/build_cast_px.py --size 90 --skip-render      # reuse frames
    python tools/build_cast_px.py --size 80 --only orc         # one model

Blender is taken from $BLENDER, then from PATH, then from the usual Windows
install locations. Rendering is ~55s per model for 8 facings at 1440.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ORDER = ["S", "SW", "W", "NW", "N", "NE", "E", "SE"]

# toon shader knobs (see tools/render_toon.py); these are the tuned values
DECIMATE, HEAD_SCALE, SHADOW_BAND, POSTERIZE, TAA = "0.12", "1.8", "0.52", "0", "1"

BLENDER_CANDIDATES = [
    r"C:/Program Files/Blender Foundation/Blender 4.4/blender.exe",
    r"C:/Program Files/Blender Foundation/Blender 4.3/blender.exe",
    r"C:/Program Files/Blender Foundation/Blender 4.2/blender.exe",
    "/Applications/Blender.app/Contents/MacOS/Blender",
]


def find_blender():
    env = os.environ.get("BLENDER", "").strip()
    if env:
        if os.path.isfile(env):
            return env
        raise SystemExit("$BLENDER points at %r, which does not exist" % env)
    exe = shutil.which("blender")
    if exe:
        return exe
    for cand in BLENDER_CANDIDATES:
        if os.path.isfile(cand):
            return cand
    raise SystemExit("Blender not found: set BLENDER=/path/to/blender, "
                     "or put it on PATH")


NOISE_TOKENS = {"3d", "model", "character", "figure", "fantasy", "hd", "lowpoly"}


def slugify(name):
    """'wizard character 3d model.glb' -> 'wizard', 'elf archer 3d model' -> 'elf_archer'."""
    tokens = [t for t in re.split(r"[^0-9a-zA-Z]+", name) if t]
    kept = [t for t in tokens if t.lower() not in NOISE_TOKENS] or tokens
    return ("_".join(kept).lower() or "model")


def discover(glb_dir):
    """Every .glb in the directory becomes one sprite set, slug = file name."""
    if not os.path.isdir(glb_dir):
        raise SystemExit("glb dir not found: %s" % glb_dir)
    found = []
    for fn in sorted(os.listdir(glb_dir)):
        if fn.lower().endswith(".glb"):
            found.append((slugify(os.path.splitext(fn)[0]), os.path.join(glb_dir, fn)))
    if not found:
        raise SystemExit("no .glb files in %s" % glb_dir)
    return found


def render(blender, glb, outdir, res):
    cmd = [blender, "-b", "--factory-startup", "--python",
           os.path.join(ROOT, "tools", "render_toon.py"), "--",
           os.path.abspath(glb), os.path.abspath(outdir), DECIMATE, HEAD_SCALE,
           SHADOW_BAND, POSTERIZE, TAA, str(res)]
    print("  render ->", outdir)
    subprocess.run(cmd, cwd=ROOT, check=True, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)


def vote(hidir, outdir, size):
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "px_ssaa.py"),
                    hidir, outdir, "--size", str(size), "--levels", "8",
                    "--cover", "0.30"], cwd=ROOT, check=True)


def write_extras(framedir, size, res):
    names = [n for n in ORDER if os.path.exists(os.path.join(framedir, n + ".png"))]
    meta = {"cell_w": size, "cell_h": size, "order": names,
            "mode": "ssaa-vote+outline",
            "source": "glb high-res un-AA render, %d subpixels/block" % (res // size)}
    with open(os.path.join(framedir, "sprite.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    sheet = Image.new("RGBA", (size * len(names), size), (0, 0, 0, 0))
    for i, n in enumerate(names):
        sheet.alpha_composite(Image.open(os.path.join(framedir, n + ".png")).convert("RGBA"),
                              (i * size, 0))
    sheet.save(os.path.join(framedir, "sheet.png"))
    prev = sheet.resize((sheet.width * 4, sheet.height * 4), Image.NEAREST)
    bg = Image.new("RGBA", prev.size, (22, 24, 30, 255))
    bg.alpha_composite(prev)
    bg.convert("RGB").save(os.path.join(framedir, "preview_x4.png"))

    # 4x2 atlas: row 0 = S SW W NW, row 1 = N NE E SE
    atlas = Image.new("RGBA", (size * 4, size * 2), (0, 0, 0, 0))
    for i, n in enumerate(names):
        atlas.alpha_composite(Image.open(os.path.join(framedir, n + ".png")).convert("RGBA"),
                              ((i % 4) * size, (i // 4) * size))
    atlas.save(os.path.join(framedir, "atlas_4x2.png"))

    x2 = os.path.join(os.path.dirname(framedir) + "_x2", os.path.basename(framedir))
    os.makedirs(x2, exist_ok=True)
    for n in names:
        Image.open(os.path.join(framedir, n + ".png")).resize(
            (size * 2, size * 2), Image.NEAREST).save(os.path.join(x2, n + ".png"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--glb-dir", type=str, default=os.path.join(ROOT, "assets", "characters"),
                    help="folder scanned for *.glb (default assets/characters)")
    ap.add_argument("--size", type=int, default=90)
    ap.add_argument("--res", type=int, default=1440)
    ap.add_argument("--skip-render", action="store_true", dest="skip_render")
    ap.add_argument("--only", type=str, default="",
                    help="comma separated slug substrings, e.g. --only orc,elf")
    ap.add_argument("--out", type=str, default="",
                    help="output root, default out/cast<size>")
    args = ap.parse_args()

    if args.res % args.size:
        raise SystemExit("%d is not an integer multiple of %d" % (args.res, args.size))
    print("block = %d subpixels" % (args.res // args.size))

    only = [s for s in args.only.split(",") if s]
    outroot = args.out or os.path.join(ROOT, "out", "cast%d" % args.size)
    hidir_root = os.path.join(outroot, "_hi%d" % args.res)
    blender = None if args.skip_render else find_blender()

    models = discover(args.glb_dir)
    picked = [m for m in models if not only or any(o in m[0] for o in only)]
    if not picked:
        raise SystemExit("nothing matched --only %s; available: %s"
                         % (args.only, ", ".join(m[0] for m in models)))
    print("models: " + ", ".join(m[0] for m in picked))

    for slug, glb in picked:
        hidir = os.path.join(hidir_root, slug)
        if not args.skip_render:
            render(blender, glb, hidir, args.res)
        elif not os.path.isdir(hidir):
            print("  skip %s (no %dx%d render in %s)" % (slug, args.res, args.res, hidir))
            continue
        outdir = os.path.join(outroot, slug)
        vote(hidir, outdir, args.size)
        write_extras(outdir, args.size, args.res)
        print("  ok", slug)

    print("done ->", outroot)


main()
