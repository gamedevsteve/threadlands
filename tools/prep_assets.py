"""
Threadlands — asset preparation.

The source art ships as opaque PNGs on a white background, which makes every
sprite a white box on the map. This keys out the background, crops to the art,
and downscales to something a canvas can push at 60fps.

The key is a flood fill from the border, so white *inside* the art (a highlight,
a whitewashed wall) survives — only background connected to the edge is removed.

Run:  python3 tools/prep_assets.py
"""
from collections import deque
from pathlib import Path
import sys
import zlib

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets"
OUT = ROOT / "src" / "assets"

# (source stem, output name, target width, mirror)
#
# Every variant is prepped: a settlement picks its own art when it is founded,
# so all three of each kind ship. The output names are what `art` holds on a
# settlement, and `SETTLEMENT_ART` in src/shared/types.ts has to list the same
# ones — a name in one and not the other is art that cannot be chosen, or a
# choice with no art behind it.
#
# `mirror` flips the art left-to-right on the way through. The settlements were
# drawn lit from one side and these later pieces from the other, so mirroring
# them is what makes a tile look like it belongs on the same map. It is a plain
# horizontal flip — anything with legible writing on it will read backwards, so
# check the output rather than trusting the flag.
#
# A missing source is reported and skipped, so a row can be written before the
# art for it exists.
JOBS = [
    ("camp-1", "camp-1", 512, False),
    ("camp-2", "camp-2", 512, False),
    ("camp-3", "camp-3", 512, False),
    ("city-castle-1", "city-1", 512, False),
    ("city-castle-2", "city-2", 512, False),
    ("city-castle-3", "city-3", 512, False),
    ("cottage", "cottage", 512, False),
    # Drawn but not yet used by anything. Prepped so they are ready and so the
    # pipeline is the only place that has ever touched them.
    ("bounty-board", "bounty-board", 512, True),
    ("library", "library", 512, True),
    ("post-office", "post-office", 512, True),
    ("flag-pole", "flag-pole", 512, True),
]

# Animation sheets: (source stem, output name, columns, rows, frame width, mirror)
#
# Sliced into `name-0.png` … `name-N.png`, one file per frame, which is what
# the renderer's sprite loader already understands.
#
# Three things a sheet needs that a single sprite does not:
#
#   * Frames are cropped to the union of every frame's bounds, never each to
#     its own. Cropping frame by frame recentres each one and the animation
#     judders in place instead of playing.
#   * The mirror is applied per frame. Flipping the sheet whole would also
#     reverse the order the frames play in.
#   * The flag is drawn white so it can be tinted at draw time — white
#     multiplied by a colour is that colour, and the greys stay as shading.
#     Nothing here may touch its colour, and `--sheet-report` says whether the
#     art really is neutral enough for that to work.
SHEETS = [
    ("flag", "flag", 8, 1, 256, True),
]

# How close to the corner colour still counts as background.
#
# Generous on purpose: the art does not sit on flat white but on a soft grey
# vignette, and a tight tolerance leaves a ragged half-transparent collar that
# shows up the moment anything glows around the sprite. The fill is
# connectivity-based, so a high tolerance only ever eats background reachable
# from the border — light colours enclosed by the art are safe.
TOLERANCE = 62
# Pixels of alpha ramp at the edge. Keep at 0: the LANCZOS downscale already
# antialiases the alpha, and a hard ring here haloes where tiles overlap.
FEATHER = 0


def key_background(img: Image.Image) -> Image.Image:
    """Flood fill from every border pixel, clearing what matches the corners."""
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()

    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    bg = tuple(sum(c[i] for c in corners) // len(corners) for i in range(3))

    def is_bg(p):
        return abs(p[0] - bg[0]) + abs(p[1] - bg[1]) + abs(p[2] - bg[2]) <= TOLERANCE * 3

    seen = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not seen[y * w + x] and is_bg(px[x, y]):
                seen[y * w + x] = 1
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not seen[y * w + x] and is_bg(px[x, y]):
                seen[y * w + x] = 1
                q.append((x, y))

    while q:
        x, y = q.popleft()
        px[x, y] = (px[x, y][0], px[x, y][1], px[x, y][2], 0)
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and is_bg(px[nx, ny]):
                seen[ny * w + nx] = 1
                q.append((nx, ny))

    # Soften the boundary: any kept pixel touching a cleared one gets partial alpha.
    for _ in range(FEATHER):
        edge = []
        for y in range(h):
            for x in range(w):
                if px[x, y][3] != 255:
                    continue
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < w and 0 <= ny < h and px[nx, ny][3] == 0:
                        edge.append((x, y))
                        break
        for x, y in edge:
            r, g, b, _ = px[x, y]
            px[x, y] = (r, g, b, 140)

    return img


GROUND_OUT = OUT / "ground"

# How much of each edge is taken from the base texture, and how far the variant
# fades in behind it, as a fraction of the texture's width.
#
# Only the outermost pixels actually have to match, so KEEP stays small and the
# work is done by a wide FADE — that way a variant covers most of its tile
# instead of reading as a blob marooned in the middle of one.
EDGE_KEEP = 0.03
EDGE_FADE = 0.13  # only used if variants are ever baked back into tiles


def edge_mask(size: tuple[int, int], keep: float, fade: float) -> Image.Image:
    """
    White in the middle, black at the border, with a soft ramp between.

    Compositing a variant onto the base through this mask replaces the inside
    and leaves the outside alone — which is the whole trick. Every variant then
    ends in exactly the same pixels as the base, so any two of them butt
    together seamlessly, in any arrangement, including against themselves.
    """
    w, h = size
    from PIL import ImageDraw

    b = int(min(w, h) * keep)
    f = max(1, int(min(w, h) * fade))

    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    d.rectangle([b + f, b + f, w - 1 - (b + f), h - 1 - (b + f)], fill=255)
    for i in range(f):
        v = round(255 * (i + 1) / (f + 1))
        inset = b + i
        d.rectangle([inset, inset, w - 1 - inset, h - 1 - inset], outline=v)
    return m


# Patch sizes, as (canvas size in texture pixels, how much of it the blob fills).
#
# A patch is baked as its own transparent sprite rather than as a variant of the
# ground tile. That is what frees it from the tile lattice: patches can be any
# size, land anywhere, and overlap into each other, instead of every one being
# exactly one cell and separated from its neighbours by the cell border.
PATCH_SIZES = [
    (360, 0.92),
    (560, 0.88),
    (820, 0.84),
    (1180, 0.80),
    (1600, 0.76),
]
SHAPES_PER_SIZE = 2


def blob_mask(size: int, fill: float, seed: int) -> Image.Image:
    """
    One irregular, soft-edged blob: a radial falloff roughed up by blurred noise.

    The radial term guarantees the alpha reaches zero before the sprite's bounds,
    so a patch always fades into whatever is under it. The noise is what stops it
    being a circle.
    """
    import random
    from PIL import ImageChops, ImageDraw, ImageFilter, ImageOps

    rng = random.Random(seed)

    # Radial falloff, drawn as nested ellipses: opaque core, soft shoulder.
    radial = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(radial)
    r_out = size * 0.5 * fill
    steps = 64
    for i in range(steps):
        t = i / (steps - 1)
        r = r_out * (1 - t)
        v = round(255 * min(1.0, (t * 2.6) ** 0.85))
        c = size / 2
        d.ellipse([c - r, c - r, c + r, c + r], fill=v)
    radial = radial.filter(ImageFilter.GaussianBlur(size * 0.03))

    coarse = rng.choice([5, 6, 8])
    noise = Image.new("L", (coarse, coarse))
    noise.putdata([rng.randrange(256) for _ in range(coarse * coarse)])
    field = noise.resize((size, size), Image.BICUBIC).filter(ImageFilter.GaussianBlur(size * 0.5 / coarse))
    field = ImageOps.autocontrast(field).point(lambda v: min(255, int(60 + v * 1.5)))

    return ImageChops.multiply(radial, field)


def tiled(img: Image.Image, size: int) -> Image.Image:
    """Fill a square by repeating a tileable texture."""
    out = Image.new("RGB", (size, size))
    for y in range(0, size, img.height):
        for x in range(0, size, img.width):
            out.paste(img, (x, y))
    return out


def bake_patches(src: Image.Image, name: str, weight: int) -> list[dict]:
    """Every size and shape of one variant, as cropped transparent sprites."""
    made: list[dict] = []
    for si, (canvas, fill) in enumerate(PATCH_SIZES):
        field = tiled(src, canvas)
        for j in range(SHAPES_PER_SIZE):
            # crc32, not hash(): Python salts string hashing per process, so
            # hash() reshuffled every patch on every run and each `npm run
            # assets` produced twenty files of diff that meant nothing.
            seed = (zlib.crc32(name.encode()) & 0xFFFF) + si * 7919 + j * 104729
            mask = blob_mask(canvas, fill, seed)
            patch = field.convert("RGBA")
            patch.putalpha(mask)
            box = patch.getbbox()
            if box:
                patch = patch.crop(box)
            # WebP, because the large patches are mostly soft alpha and PNG
            # makes the ground set an order of magnitude heavier than it needs.
            out_name = f"{name}-{si}{j}.webp"
            patch.save(GROUND_OUT / out_name, quality=88, method=5)
            made.append(
                {"file": out_name, "group": name, "w": patch.width, "h": patch.height, "weight": weight}
            )
    print(f"  {name}: {len(made)} patches, {made[0]['w']}px to {made[-1]['w']}px  weight {weight}")
    return made


def edge_mismatch(img: Image.Image) -> tuple[int, int]:
    """How far opposite edges are from matching. Under ~30 reads as seamless."""
    rgb = img.convert("RGB")
    px = rgb.load()
    w, h = rgb.size

    def avg(a, b):
        return sum(abs(p[i] - q[i]) for p, q in zip(a, b) for i in range(3)) // max(1, len(a))

    left = [px[0, y] for y in range(0, h, 3)]
    right = [px[w - 1, y] for y in range(0, h, 3)]
    top = [px[x, 0] for x in range(0, w, 3)]
    bottom = [px[x, h - 1] for x in range(0, w, 3)]
    return avg(left, right), avg(top, bottom)


def weight_of(stem: str) -> tuple[str, int]:
    """`grass-meadow@3` means "three times as common as a weight-1 variant"."""
    if "@" in stem:
        name, _, w = stem.rpartition("@")
        if w.isdigit():
            return name, max(1, int(w))
    return stem, 1


def example_variants(base: Image.Image) -> None:
    """
    Two starting points, written next to the base the first time this runs.

    Deliberately soft — broad tonal drift rather than scattered detail, so they
    read as the same ground in a different mood whatever the base's style is.
    Hand-painted variants can be far more characterful; these only exist so the
    mechanic is visible before anyone opens an editor. Replace or delete them.
    """
    import random
    from PIL import ImageDraw, ImageFilter

    w, h = base.size
    rgb = base.convert("RGB")

    def drifted(tint: tuple[int, int, int], strength: float, blobs: int, seed: int,
                lo: int, hi: int) -> Image.Image:
        rng = random.Random(seed)
        mask = Image.new("L", (w, h), 0)
        d = ImageDraw.Draw(mask)
        for _ in range(blobs):
            cx, cy = rng.randrange(w), rng.randrange(h)
            r = rng.randint(lo, hi)
            value = rng.randint(120, 255)
            # Draw wrapped, so a patch crossing an edge continues on the far side.
            for dx in (-w, 0, w):
                for dy in (-h, 0, h):
                    d.ellipse([cx - r + dx, cy - r + dy, cx + r + dx, cy + r + dy], fill=value)
        mask = mask.filter(ImageFilter.GaussianBlur(radius=w * 0.05))
        out = rgb.copy()
        out.paste(Image.blend(rgb, Image.new("RGB", (w, h), tint), strength), (0, 0), mask)
        return out

    drifted((214, 206, 120), 0.40, 16, 11, int(w * 0.10), int(w * 0.20)).save(SRC / "grass-meadow@2.png")
    drifted((150, 132, 84), 0.42, 10, 29, int(w * 0.09), int(w * 0.17)).save(SRC / "grass-scrub.png")

    print("  wrote assets/grass-meadow@2.png and assets/grass-scrub.png as examples")


def prepare_banner(width: int = 768) -> None:
    """
    The name plate. Black linework on a white body, with its own alpha.

    Left black and white on purpose: the renderer multiplies a colour through it
    at draw time, which turns the white body whatever colour a settlement's state
    calls for while leaving the linework black.
    """
    src = SRC / "banner.png"
    if not src.exists():
        return
    img = Image.open(src).convert("RGBA")
    box = img.getbbox()
    if box:
        img = img.crop(box)
    img = img.resize((width, round(width * img.height / img.width)), Image.LANCZOS)
    img.save(OUT / "banner.png", optimize=True)
    print(f"  banner.png -> banner.png  {img.width}x{img.height}")


def squircle_mask(size: int, n: float = 5.0, supersample: int = 4) -> Image.Image:
    """
    Apple's icon shape: a superellipse, not a rounded rectangle.

    Drawn large and shrunk so the curve comes out smooth without hand-rolled
    antialiasing.
    """
    from PIL import ImageDraw

    big = size * supersample
    m = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(m)
    r = big / 2
    # For each row, solve the superellipse for its half-width.
    for y in range(big):
        ny = (y + 0.5 - r) / r
        t = 1 - min(1.0, abs(ny) ** n)
        if t <= 0:
            continue
        hx = r * (t ** (1 / n))
        d.line([(r - hx, y), (r + hx, y)], fill=255)
    return m.resize((size, size), Image.LANCZOS)


def prepare_icon(size: int = 1024) -> None:
    """
    The app icon.

    The art arrives as a square with a black border band around it, which macOS
    would render as a black tile. Flood filling the black is the obvious move
    and the wrong one here: the illustration's frame is deliberately broken at
    the top, so the fill pours through the gap and eats the sky. Instead the
    content is cropped out of its padding and cut to Apple's squircle.
    """
    import shutil
    import subprocess

    src = SRC / "appicon.png"
    if not src.exists():
        return

    img = Image.open(src).convert("RGB")
    px = img.load()
    w, h = img.size

    # The bounding box of everything that is not the black surround.
    xs, ys = [], []
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b = px[x, y]
            if r + g + b > 70:
                xs.append(x)
                ys.append(y)
    if xs:
        img = img.crop((min(xs), min(ys), max(xs) + 1, max(ys) + 1))

    # Square it off on the longer side before masking, so the shape is not oval.
    side = max(img.size)
    square = Image.new("RGB", (side, side), (0, 0, 0))
    square.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    icon = square.resize((size, size), Image.LANCZOS).convert("RGBA")
    icon.putalpha(squircle_mask(size))

    build = ROOT / "build"
    build.mkdir(exist_ok=True)
    icon.save(build / "icon.png", optimize=True)
    # Shown in the Dock while developing, where no packaged .icns exists yet.
    icon.resize((512, 512), Image.LANCZOS).save(OUT / "appicon.png", optimize=True)
    print(f"  appicon.png -> build/icon.png ({size}) and src/assets/appicon.png (512)")

    if not shutil.which("iconutil"):
        return
    iconset = build / "icon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()
    for s_ in (16, 32, 128, 256, 512):
        icon.resize((s_, s_), Image.LANCZOS).save(iconset / f"icon_{s_}x{s_}.png")
        icon.resize((s_ * 2, s_ * 2), Image.LANCZOS).save(iconset / f"icon_{s_}x{s_}@2x.png")
    try:
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(build / "icon.icns")], check=True
        )
        shutil.rmtree(iconset)
        print("  build/icon.icns written")
    except subprocess.CalledProcessError as e:
        print(f"  !! iconutil failed: {e}")


# UI buttons. Each arrives as framed art on an opaque black square, so each is
# cropped to its content and cut to the same squircle as the app icon.
UI_ICONS = ["info", "home", "blank", "build"]


def prepare_ui_icons(size: int = 128) -> None:
    for name in UI_ICONS:
        src = SRC / f"{name}.png"
        if not src.exists():
            print(f"  !! assets/{name}.png missing")
            continue
        img = Image.open(src).convert("RGB")
        px = img.load()
        w, h = img.size
        xs, ys = [], []
        for y in range(0, h, 2):
            for x in range(0, w, 2):
                r, g, b = px[x, y]
                if r + g + b > 70:
                    xs.append(x)
                    ys.append(y)
        if xs:
            img = img.crop((min(xs), min(ys), max(xs) + 1, max(ys) + 1))
        side = max(img.size)
        square = Image.new("RGB", (side, side), (0, 0, 0))
        square.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
        icon = square.resize((size, size), Image.LANCZOS).convert("RGBA")
        icon.putalpha(squircle_mask(size))
        icon.save(OUT / f"{name}.png", optimize=True)
        print(f"  {name}.png -> {name}.png  {size}x{size}")


def prepare_parchment(width: int = 887) -> None:
    """The side panel's backdrop. Kept at its native width; webp for the size."""
    src = SRC / "parchment.png"
    if not src.exists():
        return
    img = Image.open(src).convert("RGB")
    if img.width != width:
        img = img.resize((width, round(width * img.height / img.width)), Image.LANCZOS)
    img.save(OUT / "parchment.webp", quality=90, method=5)
    print(f"  parchment.png -> parchment.webp  {img.width}x{img.height}")


def prepare_ground(width: int = 512) -> None:
    """
    The base texture plus any variants, all forced to share the base's border.

    Author a variant by copying assets/grass.png, changing whatever you like in
    the middle, and saving it as assets/grass-<name>.png. The edges are put back
    for you, so you never have to be careful near them.
    """
    import json

    base_src = SRC / "grass.png"
    if not base_src.exists():
        print("  !! assets/grass.png missing — no ground texture")
        return

    GROUND_OUT.mkdir(parents=True, exist_ok=True)
    for stale in [*GROUND_OUT.glob("*.png"), *GROUND_OUT.glob("*.webp")]:
        stale.unlink()

    base = Image.open(base_src).convert("RGB")
    if base.width != width:
        base = base.resize((width, round(width * base.height / base.width)), Image.LANCZOS)

    lr, tb = edge_mismatch(base)
    print(f"  grass.png -> ground/grass.png  {base.width}x{base.height}  seam L/R {lr} T/B {tb}")
    base.save(GROUND_OUT / "grass.png", optimize=True)

    variants = sorted(SRC.glob("grass-*.png"))
    if not variants:
        example_variants(base)
        variants = sorted(SRC.glob("grass-*.png"))

    patches: list[dict] = []
    for v in variants:
        name, weight = weight_of(v.stem)
        img = Image.open(v).convert("RGB")
        if img.size != base.size:
            img = img.resize(base.size, Image.LANCZOS)
        patches.extend(bake_patches(img, name, weight))

    (OUT / "ground.json").write_text(
        json.dumps({"size": base.width, "base": "grass.png", "patches": patches}, indent=2) + "\n"
    )
    print(f"  ground.json: base + {len(patches)} patches")


def prepare_sheets() -> None:
    """Slice each animation sheet into one PNG per frame."""
    for stem, name, cols, rows, width, mirror in SHEETS:
        src = SRC / f"{stem}.png"
        if not src.exists():
            print(f"  !! missing {src}")
            continue
        sheet = Image.open(src)
        if sheet.width % cols or sheet.height % rows:
            print(f"  !! {stem}.png is {sheet.size}, which {cols}x{rows} does not divide evenly")
            continue
        fw, fh = sheet.width // cols, sheet.height // rows

        keyed = sheet.mode in ("RGBA", "LA") and sheet.getchannel("A").getextrema()[0] < 250
        frames = []
        for i in range(cols * rows):
            x, y = (i % cols) * fw, (i // cols) * fh
            f = sheet.crop((x, y, x + fw, y + fh))
            frames.append(f.convert("RGBA") if keyed else key_background(f))
        if keyed:
            print(f"  {stem}.png has its own alpha — keying skipped")
        else:
            # A white flag flattened onto a pale background is the one case the
            # flood fill cannot survive: it cannot tell the art from the paper.
            print(f"  !! {stem}.png is opaque, so the background was keyed by colour."
                  f" If the art is white on white, check the frames before trusting them.")

        # One box for every frame, so the flag stays nailed to its pole.
        boxes = [f.getbbox() for f in frames]
        boxes = [b for b in boxes if b]
        if boxes:
            union = (min(b[0] for b in boxes), min(b[1] for b in boxes),
                     max(b[2] for b in boxes), max(b[3] for b in boxes))
            frames = [f.crop(union) for f in frames]

        height = round(width * frames[0].height / frames[0].width)
        for i, f in enumerate(frames):
            f = f.resize((width, height), Image.LANCZOS)
            # Per frame, so the order plays forwards.
            if mirror:
                f = f.transpose(Image.FLIP_LEFT_RIGHT)
            f.save(OUT / f"{name}-{i}.png", optimize=True)

        # Is it actually tintable? Multiply only reads as a colour change if the
        # art is neutral; a sheet with real colour in it will come out muddy.
        rgb = frames[0].convert("RGBA")
        px = rgb.load()
        spread, lit = 0, 0
        for yy in range(0, rgb.height, 3):
            for xx in range(0, rgb.width, 3):
                r, g, b, a = px[xx, yy]
                if a < 200:
                    continue
                lit += 1
                spread = max(spread, max(r, g, b) - min(r, g, b))
        neutral = "neutral — multiply will tint cleanly" if spread <= 16 else f"has colour (spread {spread}) — multiply will muddy it"
        print(f"  {stem}.png -> {name}-0..{len(frames) - 1}.png  {width}x{height} each"
              f"{' · mirrored' if mirror else ''}  ·  {neutral}")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for stem, name, width, mirror in JOBS:
        src = SRC / f"{stem}.png"
        if not src.exists():
            print(f"  !! missing {src}")
            continue
        img = Image.open(src)
        # Art exported with real transparency is left exactly as drawn: keying
        # is only ever a rescue for art that arrives flattened onto a
        # background. Nothing here edits pixels the artist meant to keep.
        if img.mode in ("RGBA", "LA") and img.getchannel("A").getextrema()[0] < 250:
            img = img.convert("RGBA")
            print(f"  {stem}.png has its own alpha — keying skipped")
        else:
            img = key_background(img)
        box = img.getbbox()          # crop to the art, so hex math has no margin to fight
        if box:
            img = img.crop(box)
        height = round(width * img.height / img.width)
        img = img.resize((width, height), Image.LANCZOS)
        # Last, so what is written is what you look at — the crop and the
        # downscale both work the same either way round.
        if mirror:
            img = img.transpose(Image.FLIP_LEFT_RIGHT)
        dst = OUT / f"{name}.png"
        img.save(dst, optimize=True)
        flipped = " · mirrored" if mirror else ""
        print(f"  {stem}.png -> {dst.name}  {width}x{height}  ratio {img.width / img.height:.4f}{flipped}")
    prepare_sheets()
    prepare_ground()
    prepare_banner()
    prepare_parchment()
    prepare_icon()
    prepare_ui_icons()
    return 0


if __name__ == "__main__":
    sys.exit(main())
