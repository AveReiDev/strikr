#!/usr/bin/env python3
"""
Generates the app icons.

Dev tooling, not part of the app — run it once and commit the PNGs. The app
itself ships no build step and no image dependencies.

    python3 tools/make-icons.py

Design: near-black field, heavy white "S", red accent dot. The full STRIKR
wordmark is unreadable at 60px on a home screen, so the initial carries it.
Colours are taken from styles/tokens.css.
"""

import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "icons")

BG = (13, 13, 13, 255)        # --bg
FG = (244, 244, 244, 255)     # --fg
ACCENT = (255, 35, 35, 255)   # --accent

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Black.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
]


def load_font(px):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, px)
            except OSError:
                continue
    raise SystemExit("no usable font found; edit FONT_CANDIDATES")


def render(size, padded=False, supersample=4):
    """
    Draw at 4x and downsample, which is the cheapest way to get clean edges
    on the dot without writing an antialiaser.

    `padded` keeps the mark well inside the frame for maskable icons, which
    the platform crops to its own shape.
    """
    s = size * supersample
    img = Image.new("RGBA", (s, s), BG)
    d = ImageDraw.Draw(img)

    scale = 0.52 if padded else 0.70
    font = load_font(int(s * scale))

    # Measure the glyph so the S and the dot can be centred as a pair rather
    # than the S alone, which would look off-centre.
    left, top, right, bottom = d.textbbox((0, 0), "S", font=font)
    s_w, s_h = right - left, bottom - top

    dot_r = s * (0.042 if padded else 0.055)
    gap = s * 0.030
    total_w = s_w + gap + dot_r * 2

    x0 = (s - total_w) / 2
    y0 = (s - s_h) / 2

    d.text((x0 - left, y0 - top), "S", font=font, fill=FG)

    cx = x0 + s_w + gap + dot_r
    cy = y0 + s_h - dot_r          # sits on the baseline, as in the wordmark
    d.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=ACCENT)

    return img.resize((size, size), Image.LANCZOS)


SPECS = [
    ("icon-180.png", 180, False),   # apple-touch-icon
    ("icon-192.png", 192, False),
    ("icon-512.png", 512, False),
    ("icon-maskable-512.png", 512, True),
]

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, size, padded in SPECS:
        path = os.path.join(OUT, name)
        render(size, padded).save(path, "PNG", optimize=True)
        print(f"  {name}  {size}x{size}  {os.path.getsize(path):,} bytes")
    print(f"\nwritten to {OUT}")
