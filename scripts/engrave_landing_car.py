#!/usr/bin/env python3
"""Engrave the home page car illustration into printable ink masks.

The home page prints its plates in two or three inks that follow the theme,
so the car picture is not shipped as a colour image. This script re-screens
a transparent PNG of the car with diagonal engraving lines and writes alpha
masks the page colours with CSS:

    murano-silhouette  paper (day) or solid black (night) under the car
    murano-ink         day edition: dark tones printed as ink lines
    murano-highlight   night edition: light tones printed as cream lines
    murano-lamps       tail lights and reflectors, printed in rust

The licence plate is printed without the line screen so its characters stay
legible at the small size the plate is shown.

Usage (needs Pillow and NumPy, which the app itself does not install):

    python scripts/engrave_landing_car.py path/to/murano.png
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "static" / "images" / "landing"
WIDTH = 600
SUPERSAMPLE = 2
LINE_PERIOD = 4.6  # output pixels between engraving lines
# Licence plate, in source pixels once the image is cropped to its content.
PLATE_BOX = (249, 501, 422, 607)


def load_source(path: Path) -> Image.Image:
    image = Image.open(path).convert("RGBA")
    return image.crop(image.getbbox())


def morph(mask: np.ndarray, size: int, *, grow: bool) -> np.ndarray:
    image = Image.fromarray(mask.astype(np.uint8) * 255, "L")
    rank = ImageFilter.MaxFilter(size) if grow else ImageFilter.MinFilter(size)
    return np.array(image.filter(rank)) > 127


def engrave(source: Image.Image) -> dict[str, np.ndarray]:
    width = WIDTH * SUPERSAMPLE
    height = round(source.height * width / source.width)
    scale = width / source.width
    big = source.resize((width, height), Image.LANCZOS)
    rgba = np.array(big).astype(np.float32) / 255.0
    red, green, blue, alpha = (rgba[..., i] for i in range(4))

    tone = 0.299 * red + 0.587 * green + 0.114 * blue
    # A little local contrast so reflections survive the screen.
    tone_image = Image.fromarray((tone * 255).astype(np.uint8), "L")
    blurred = np.array(tone_image.filter(ImageFilter.GaussianBlur(6))) / 255.0
    tone = np.clip(tone + 0.6 * (tone - blurred), 0, 1)

    solid = alpha > 0.5
    # Saturated reds only (lamps and reflectors), not skin or the red plate band.
    lamps = (red - np.maximum(green, blue) > 0.3) & (green < 0.38) & solid
    lamps = morph(morph(lamps, 3, grow=False), 3, grow=True)

    ys, xs = np.mgrid[0:height, 0:width]
    period = LINE_PERIOD * SUPERSAMPLE * np.sqrt(2)
    screen = 0.5 + 0.5 * np.sin(2 * np.pi * (xs - ys) / period)

    # Inside the plate, print flat tones instead of lines so it stays readable.
    x0, y0, x1, y1 = (round(v * scale) for v in PLATE_BOX)
    plate = np.zeros_like(solid)
    plate[y0:y1, x0:x1] = True
    ink_threshold = np.where(plate, 0.62, 0.14 + 0.52 * screen)
    highlight_threshold = np.where(plate, 0.62, 0.30 + 0.45 * screen)

    outline = solid & ~morph(solid, 2 * SUPERSAMPLE + 1, grow=False)
    ink = ((tone < ink_threshold) & solid & ~lamps) | outline
    highlight = ((tone > highlight_threshold) & solid & ~lamps) | outline
    return {
        "murano-silhouette": solid,
        "murano-ink": ink,
        "murano-highlight": highlight,
        "murano-lamps": lamps,
    }


def save_mask(mask: np.ndarray, name: str) -> Path:
    alpha = Image.fromarray(mask.astype(np.uint8) * 255, "L")
    size = (WIDTH, round(alpha.height / SUPERSAMPLE))
    alpha = alpha.resize(size, Image.LANCZOS)
    image = Image.new("RGBA", size, (0, 0, 0, 0))
    image.putalpha(alpha)
    path = OUT / f"{name}.webp"
    image.save(path, "WEBP", lossless=True, method=6)
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", type=Path, help="transparent PNG of the car")
    args = parser.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    for name, mask in engrave(load_source(args.source)).items():
        path = save_mask(mask, name)
        print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
