#!/usr/bin/env python3
"""Draw the repository banner.

One idea, one dominant subject: a continuous fanfold printout — the
accordion-folded, perforated-edge stationery a line printer consumes — running
into a press whose output is a single dense sealed block. It stands for an
append-only JSONL session log becoming a compact, portable artifact.

The accordion is built from alternating shear: each sheet leans one way and
its neighbour leans the other, joined by a slanted fold face. That alternation
is what makes the strip read as folded rather than as a row of cards.

The medium is risograph: flat opaque ink, a faint misregistration ghost, paper
grain, five inks. Drawn at 2x and downsampled so the edges stay clean.

Run:  python3 scripts/draw_banner.py
Out:  assets/banner.png
"""

from __future__ import annotations

import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SCALE = 2
WIDTH, HEIGHT = 2172, 724
W, H = WIDTH * SCALE, HEIGHT * SCALE

CREAM = (244, 238, 226)
NAVY = (31, 58, 95)
NAVY_MID = (48, 82, 126)
NAVY_DEEP = (22, 43, 73)
VERMILION = (210, 72, 46)
SAGE = (124, 154, 110)
MUSTARD = (217, 164, 65)
PAPER = (250, 246, 236)
PAPER_FOLD = (228, 219, 200)

TICKS = (VERMILION, SAGE, MUSTARD, NAVY, VERMILION)
TAB_COLOURS = (VERMILION, MUSTARD, SAGE, VERMILION)

OUT = Path(__file__).resolve().parent.parent / "assets" / "banner.png"


def layer() -> Image.Image:
    return Image.new("RGBA", (W, H), (0, 0, 0, 0))


def s(value: float) -> int:
    return int(round(value * SCALE))


def paper_grain(image: Image.Image, strength: float = 6.0) -> Image.Image:
    """Overlay grain without uniformly darkening the image."""
    noise = Image.effect_noise((W, H), strength).convert("L").filter(ImageFilter.GaussianBlur(0.5))
    alpha = noise.point(lambda v: int(abs(v - 128) * 0.26))
    overlay = Image.new("RGBA", (W, H), (90, 74, 52, 0))
    overlay.putalpha(alpha)
    return Image.alpha_composite(image, overlay)


def parallelogram(x0: float, x1: float, y0: float, y1: float, shear: float) -> list[tuple[int, int]]:
    """A sheet face: the top edge shifted horizontally against the bottom edge."""
    return [(s(x0 + shear), s(y0)), (s(x1 + shear), s(y0)), (s(x1), s(y1)), (s(x0), s(y1))]


def fold_face(left: tuple[float, float, float], right: tuple[float, float, float]) -> list[tuple[int, int]]:
    """The turned edge joining two sheets. `left`/`right` are (x_edge, shear, _) triples."""
    lx, lshear, _ = left
    rx, rshear, _ = right
    return [(s(lx + lshear), s(TOP)), (s(rx + rshear), s(TOP)), (s(rx), s(BOTTOM)), (s(lx), s(BOTTOM))]


# --- geometry ---------------------------------------------------------------

TOP, BOTTOM = 104.0, 622.0
PANELS = 4
PANEL_W = 250.0
SHEAR = 30.0
START_X = 70.0
# Adjacent sheets lean opposite ways, so a uniform gap would make the fold
# faces alternate between very narrow and very wide — one of them reading as a
# blank page. Alternating the gap by twice the shear keeps every fold face the
# same width while still letting the sheets lean against each other.
GAP = 76.0

BLOCK_L, BLOCK_R = 1552.0, 2032.0


def panel_geometry() -> list[tuple[float, float, float]]:
    """(x_start, x_end, shear) per sheet, with the lean alternating and the gap
    compensating so all fold faces come out the same width."""
    out = []
    x = START_X
    for index in range(PANELS):
        out.append((x, x + PANEL_W, SHEAR if index % 2 == 0 else -SHEAR))
        step = GAP + 2.0 * SHEAR if index % 2 == 0 else GAP - 2.0 * SHEAR
        x += PANEL_W + step
    return out


def draw_sheet_body(canvas: Image.Image, ghost: Image.Image, x0: float, x1: float, shear: float, index: int) -> None:
    """One sheet: face, ruled records, date tab, taxonomy ticks."""
    face = parallelogram(x0, x1, TOP, BOTTOM, shear)

    # Misregistration: a faint vermilion ghost of the outline, offset. This is
    # the whole of the riso effect; anything stronger reads as a printing fault.
    gd = ImageDraw.Draw(ghost)
    gd.polygon([(x + s(3.5), y + s(3.5)) for x, y in face], outline=VERMILION, width=s(2.6))

    cd = ImageDraw.Draw(canvas)
    cd.polygon(face, fill=PAPER, outline=NAVY)

    # Ruled lines, clipped to the leaning face so they stop at the edges.
    inner = layer()
    idraw = ImageDraw.Draw(inner)
    margin = 26.0
    rng = random.Random(900 + index * 13)
    rows = 9
    span = BOTTOM - TOP - 150.0
    for row in range(rows):
        y = TOP + 92.0 + row * (span / rows)
        width_frac = rng.uniform(0.42, 0.96)
        usable = PANEL_W - margin * 2
        # Lines follow the lean, so they sit square inside the sheet.
        at_y_shear = shear * (1.0 - (y - TOP) / (BOTTOM - TOP))
        lx = x0 + margin + at_y_shear
        idraw.rounded_rectangle(
            (s(lx), s(y), s(lx + usable * width_frac), s(y + 4.5)),
            radius=s(2),
            fill=NAVY,
        )

    # Date tab.
    cx = x0 + margin + 20.0 + shear * 0.82
    cy = TOP + 46.0
    tab_r = 21.0
    idraw.ellipse((s(cx - tab_r), s(cy - tab_r), s(cx + tab_r), s(cy + tab_r)), fill=TAB_COLOURS[index % 4])
    idraw.ellipse(
        (s(cx - tab_r), s(cy - tab_r), s(cx + tab_r), s(cy + tab_r)),
        outline=NAVY,
        width=s(2),
    )

    # Taxonomy ticks along the foot of the sheet.
    tick_y = BOTTOM - 44.0
    at_y_shear = shear * (1.0 - (tick_y - TOP) / (BOTTOM - TOP))
    for tick_index, colour in enumerate(TICKS):
        tx = x0 + margin + tick_index * 30.0 + at_y_shear
        idraw.rectangle((s(tx), s(tick_y), s(tx + 17), s(tick_y + 13)), fill=colour)

    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).polygon(face, fill=255)
    canvas.alpha_composite(Image.composite(inner, layer(), mask))


def draw_folds(canvas: Image.Image, geometry: list[tuple[float, float, float]]) -> None:
    """The turned edges, shaded so the strip reads as one folded ribbon."""
    for index in range(len(geometry) - 1):
        _, x_end, shear = geometry[index]
        x_next, _, shear_next = geometry[index + 1]

        face = fold_face((x_end, shear, 0), (x_next, shear_next, 0))

        # Fill the turned edge with a vertical gradient so it reads as a face
        # catching less light than the sheets beside it.
        shade = layer()
        sd = ImageDraw.Draw(shade)
        steps = 60
        for step in range(steps):
            t = step / steps
            y = TOP + t * (BOTTOM - TOP)
            band = PAPER_FOLD if index % 2 == 0 else (216, 206, 186)
            value = tuple(int(channel * (1.0 - 0.10 * t)) for channel in band)
            sd.rectangle((face[0][0], s(y), face[2][0], s(y + (BOTTOM - TOP) / steps) + 1), fill=value)
        mask = Image.new("L", (W, H), 0)
        ImageDraw.Draw(mask).polygon(face, fill=255)
        canvas.alpha_composite(Image.composite(shade, layer(), mask))

        cd = ImageDraw.Draw(canvas)
        cd.line([face[0], face[1]], fill=NAVY, width=s(2))
        cd.line([face[3], face[2]], fill=NAVY, width=s(2))

        # A crease down the middle of each turned edge.
        mid = [
            ((face[0][0] + face[1][0]) // 2, face[0][1]),
            ((face[3][0] + face[2][0]) // 2, face[3][1]),
        ]
        cd.line(mid, fill=NAVY, width=s(1.6))

    # Punched feed holes along the top edge, following the lean of each sheet.
    cd = ImageDraw.Draw(canvas)
    for x0, x1, shear in geometry:
        for step in range(11):
            t = step / 10.0
            x = x0 + 14.0 + t * (PANEL_W - 28.0) + shear
            y = TOP - 15.0
            r = 4.2
            cd.ellipse((s(x - r), s(y - r), s(x + r), s(y + r)), fill=CREAM, outline=NAVY, width=s(1.6))


def draw_feed(canvas: Image.Image, geometry: list[tuple[float, float, float]]) -> None:
    """A tapered ribbon carrying the strip into the press."""
    _, x_last, shear_last = geometry[-1]
    start_x = x_last + shear_last + 10.0
    mid_y = (TOP + BOTTOM) / 2.0
    end_x = BLOCK_L - 42.0

    cd = ImageDraw.Draw(canvas)
    steps = 24
    top_edge: list[tuple[int, int]] = []
    bottom_edge: list[tuple[int, int]] = []
    for step in range(steps + 1):
        t = step / steps
        x = start_x + t * (end_x - start_x)
        half = 74.0 * (1.0 - t) + 15.0 * t
        top_edge.append((s(x), s(mid_y - half)))
        bottom_edge.append((s(x), s(mid_y + half)))
    cd.polygon(top_edge + list(reversed(bottom_edge)), fill=NAVY_MID)

    # Rungs: the ribbon is the same log, still readable at this point.
    for step in range(1, 11):
        t = step / 11.0
        x = start_x + t * (end_x - start_x)
        half = (74.0 * (1.0 - t) + 15.0 * t) * 0.86
        cd.line([(s(x), s(mid_y - half)), (s(x), s(mid_y + half))], fill=PAPER, width=s(2))


def draw_block(canvas: Image.Image) -> None:
    """The sealed output: the same material, compressed."""
    cd = ImageDraw.Draw(canvas)

    # Intake teeth, drawing the ribbon in.
    teeth = 30
    tooth_h = (BOTTOM - TOP) / teeth
    for index in range(teeth):
        y = TOP + index * tooth_h
        length = 34.0 * (0.5 + 0.5 * ((index % 3) / 2.0))
        cd.polygon(
            [
                (s(BLOCK_L - length), s(y + tooth_h * 0.16)),
                (s(BLOCK_L), s(y)),
                (s(BLOCK_L), s(y + tooth_h * 0.84)),
                (s(BLOCK_L - length), s(y + tooth_h)),
            ],
            fill=VERMILION if index % 2 == 0 else NAVY,
        )

    cd.rounded_rectangle(
        (s(BLOCK_L), s(TOP), s(BLOCK_R), s(BOTTOM)),
        radius=s(8),
        fill=NAVY,
        outline=NAVY,
        width=s(2),
    )

    rng = random.Random(20260915)
    bands = 62
    band_h = (BOTTOM - TOP) / bands
    for index in range(bands):
        y = TOP + index * band_h
        cd.rectangle(
            (s(BLOCK_L + 3), s(y + 0.8), s(BLOCK_R - 3), s(y + band_h - 0.8)),
            fill=rng.choice([NAVY, NAVY, NAVY_MID, NAVY_DEEP]),
        )

    for fraction, colour in ((0.19, VERMILION), (0.48, MUSTARD), (0.74, SAGE)):
        y = TOP + (BOTTOM - TOP) * fraction
        cd.rectangle((s(BLOCK_L + 3), s(y), s(BLOCK_R - 3), s(y + band_h * 1.8)), fill=colour)

    # Perforated edges of the sealed block.
    for y in (TOP + 9.0, BOTTOM - 9.0):
        for step in range(30):
            x = BLOCK_L + 12.0 + step * ((BLOCK_R - BLOCK_L - 24.0) / 29.0)
            r = 3.2
            cd.ellipse((s(x - r), s(y - r), s(x + r), s(y + r)), fill=PAPER)

    # The seal.
    seal_r = 50.0
    scx, scy = BLOCK_R - 52.0, BOTTOM - 52.0
    cd.ellipse((s(scx - seal_r), s(scy - seal_r), s(scx + seal_r), s(scy + seal_r)), fill=CREAM, outline=VERMILION, width=s(4.6))
    cd.ellipse(
        (s(scx - seal_r + 14), s(scy - seal_r + 14), s(scx + seal_r - 14), s(scy + seal_r - 14)),
        outline=VERMILION,
        width=s(2.4),
    )


def draw_banner() -> Image.Image:
    base = Image.new("RGBA", (W, H), CREAM + (255,))
    geometry = panel_geometry()

    ghost = layer()
    # Folds first, then sheets on top, so the near sheet always wins the edge.
    folds = layer()
    draw_folds(folds, geometry)

    sheets = layer()
    for index, (x0, x1, shear) in enumerate(geometry):
        draw_sheet_body(sheets, ghost, x0, x1, shear, index)

    feed = layer()
    draw_feed(feed, geometry)

    block = layer()
    draw_block(block)

    base = Image.alpha_composite(base, ghost.filter(ImageFilter.GaussianBlur(0.5)))
    base = Image.alpha_composite(base, folds)
    base = Image.alpha_composite(base, feed)
    base = Image.alpha_composite(base, sheets)
    base = Image.alpha_composite(base, block)

    return paper_grain(base).convert("RGB").resize((WIDTH, HEIGHT), Image.LANCZOS)


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    image = draw_banner()
    image.save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT}  {image.size[0]}x{image.size[1]}  {OUT.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
