"""
Build Spendo's icon set from the supplied 1254px artwork.

The source is a rounded dark-green tile sitting on a white page with a drop shadow,
so nothing here can just resize it: the white would become a border on the home
screen, and a maskable icon would have its rounded corners cropped off by the
platform's own mask.

Three shapes come out of it:

  icon-192 / icon-512     the tile itself, corners transparent      purpose: any
  icon-maskable-512       full bleed, artwork inside the safe zone  purpose: maskable
  apple-touch-icon        full bleed, opaque, iOS rounds it itself
"""
from PIL import Image, ImageDraw, ImageFilter
import os
import sys

# The source render is not in the repository - it is a megabyte of artwork that is
# only ever read again if the logo changes - so its path is an argument.
#
#     python tools/make-icons.py path/to/icon.png
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'icon.png')
OUT = os.path.join(ROOT, 'icons')

im = Image.open(SRC).convert('RGB')

# The tile, found by the bounding box of CLEARLY DARK pixels rather than of
# not-white ones. The artwork sits on a white page with a soft drop shadow, and a
# not-white test grabs the shadow too - one pixel of that left in becomes a grey ring
# on the home screen. The height that test returns is ~19px taller than the width,
# which is the shadow; the width is the real edge, so the tile is cut square from it.
px = im.load()
lum = lambda c: 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

dark = [(x, y) for y in range(im.size[1]) for x in range(im.size[0]) if lum(px[x, y]) < 110]
L = min(x for x, _ in dark); T = min(y for _, y in dark)
R = max(x for x, _ in dark)
W = R - L + 1
tile = im.crop((L, T, L + W, T + W))

# The corner radius as actually drawn: on the row just below the top edge, how far in
# the dark pixels start.
row = [x for x in range(im.size[0]) if lum(px[x, T + 2]) < 110]
radius = min(row) - L
print(f'tile {W}px at ({L},{T}), corner radius {radius}px ({radius / W:.0%})')

# --------------------------------------------------------------- rounded corners
#
# INSET by a few pixels. A mask drawn exactly on the measured radius still let white
# through: the drawn corner is very slightly rounder than a perfect rounded-rectangle,
# so pixels ~2px outside the real curve fell inside the mask and travelled into the
# icon as white specks near each corner. Losing 8px of a 1076px tile is invisible;
# a white speck on a dark home-screen icon is not.
INSET = 8
mask = Image.new('L', (W, W), 0)
ImageDraw.Draw(mask).rounded_rectangle(
    [INSET, INSET, W - 1 - INSET, W - 1 - INSET], radius=radius, fill=255)
# One pixel of feather, so the curve is not stair-stepped when it is scaled down.
mask = mask.filter(ImageFilter.GaussianBlur(1.0))

tile_rgba = tile.convert('RGBA')
tile_rgba.putalpha(mask)

# Prove it: the four corner squares contain no artwork, so any near-white pixel left
# in them is page bleed. This has to be zero.

# ------------------------------------------------------- the background it sits on
# Sampled from inside the tile, away from the artwork. The tile is a subtle gradient,
# so a flat fill for the full-bleed icons is an average of both ends rather than one
# corner, which would leave a visible seam against the artwork's own shading.
tp = tile.load()
probes = [(int(W * a), int(W * b)) for a, b in
          [(.5, .07), (.5, .93), (.08, .5), (.92, .5), (.22, .13), (.78, .13)]]
samples = [tp[p] for p in probes]
BG = tuple(sum(c[i] for c in samples) // len(samples) for i in range(3))
print('background fill', BG, '#%02x%02x%02x' % BG)

# Prove the corners are clean. Those four squares contain no artwork, so a near-white
# pixel in them can only be the page showing through a mask that is too generous.
_flat = Image.new('RGB', (W, W), BG)
_flat.paste(tile, (0, 0), mask)
_fp = _flat.load()
leaks = 0
for (ox, oy) in [(0, 0), (W - radius, 0), (0, W - radius), (W - radius, W - radius)]:
    for y in range(oy, oy + radius, 2):
        for x in range(ox, ox + radius, 2):
            c = _fp[x, y]
            if min(c) > 200 and max(c) - min(c) < 12:
                leaks += 1
print('white page pixels left in the corners:', leaks)
assert leaks == 0, 'the corner mask is still letting the page through'

# ------------------------------------------------------------------- the artwork
# Everything meaningfully brighter than that background. Corners are excluded first
# by flattening the tile onto the fill, or the white page outside the curve reads as
# the brightest thing in the image and the box becomes the whole tile.
flat = Image.new('RGB', (W, W), BG)
flat.paste(tile, (0, 0), mask)
fp = flat.load()

# Distance from the background COLOUR, not brightness.
#
# A luminance test loses the dark teal wave inside the bowl: it computes to 91.6
# against a floor of 89.5, so it came out patchy - present in some pixels, dropped in
# the ones a shade darker. Its colour, though, is 76 away from the background while
# the background's own gradient only varies by about 15, so distance separates them
# cleanly where brightness cannot.
def dist(c):
    return ((c[0] - BG[0]) ** 2 + (c[1] - BG[1]) ** 2 + (c[2] - BG[2]) ** 2) ** 0.5

FLOOR, RAMP = 32, 26

# Gated on the corner mask, and read from `flat` rather than from the RGBA tile.
#
# Reading it from the RGBA tile put two white shards in the icon: `convert('RGB')`
# throws the alpha away and keeps what is underneath it, which at the corners is the
# white page - and white is about as far from this background as a colour gets, so
# the test kept it. `flat` has the background painted into those corners already.
mp = mask.load()
xs, ys = [], []
for y in range(0, W, 2):
    for x in range(0, W, 2):
        if mp[x, y] > 250 and dist(fp[x, y]) > FLOOR:
            xs.append(x); ys.append(y)
art_box = (min(xs), min(ys), max(xs) + 1, max(ys) + 1)
print('artwork box', art_box, 'of', W)

art = flat.crop(art_box).convert('RGBA')
# Re-cut the artwork's own alpha from the same distance test, so the tile background
# does not travel with it onto the full-bleed canvas as a slightly-wrong rectangle.
ax, ay = art.size
art_mask = Image.new('L', (ax, ay), 0)
am = art_mask.load()
ap = flat.crop(art_box).load()
gate = mask.crop(art_box).load()
for y in range(ay):
    for x in range(ax):
        if gate[x, y] < 250:
            am[x, y] = 0
            continue
        d = dist(ap[x, y])
        # A soft ramp rather than a hard cut: a 1-bit mask leaves a jagged edge on
        # artwork that was drawn with anti-aliasing and soft shadows.
        am[x, y] = 0 if d <= FLOOR else min(255, int((d - FLOOR) / RAMP * 255))
art_mask = art_mask.filter(ImageFilter.GaussianBlur(0.6))
art.putalpha(art_mask)


def full_bleed(size, content_fraction, opaque):
    """Artwork centred on a filled square, at `content_fraction` of the width."""
    canvas = Image.new('RGBA', (size, size), BG + (255,))
    target = int(size * content_fraction)
    scale = target / max(art.size)
    w, h = int(art.size[0] * scale), int(art.size[1] * scale)
    resized = art.resize((w, h), Image.LANCZOS)
    canvas.alpha_composite(resized, ((size - w) // 2, (size - h) // 2))
    return canvas.convert('RGB') if opaque else canvas


os.makedirs(OUT, exist_ok=True)

for size in (192, 512):
    tile_rgba.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f'icon-{size}.png'))

# Maskable: the platform may crop to a circle of 80% diameter, so the largest square
# guaranteed to survive is 80/sqrt(2) = 57% of the width. 60% leaves a little room
# without wasting the canvas.
full_bleed(512, 0.60, False).save(os.path.join(OUT, 'icon-maskable-512.png'))

# iOS composites a transparent icon onto black and applies its own rounding, so this
# one is opaque and full bleed. Its corner radius is smaller than a maskable crop, so
# the artwork can be larger.
full_bleed(180, 0.74, True).save(os.path.join(OUT, 'apple-touch-icon.png'))

# Browser tab. Small enough that the full artwork would be mud; the tile reads better.
tile_rgba.resize((32, 32), Image.LANCZOS).save(os.path.join(OUT, 'favicon-32.png'))

for f in ('icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
          'apple-touch-icon.png', 'favicon-32.png'):
    p = os.path.join(OUT, f)
    print(f'  {f:24} {Image.open(p).size}  {os.path.getsize(p) / 1024:6.1f} KB')
