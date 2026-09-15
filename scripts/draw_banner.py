#!/usr/bin/env python3
"""Draw the repository banner.

One dominant subject: an open archive drawer seen from above, packed with filed
cards, one card drawn up out of the row and standing proud. It stands for
reading somebody else's on-disk sessions and taking a copy out into a portable,
catalogued archive.

Two supporting motifs: the coloured tabs along the card tops, and the round
stamp on the drawn card.

Medium is cut-paper collage — flat opaque shapes, visible cut edges, soft drop
shadows. The palette and the treatment are deliberately unlike the screen-print
banner used on this machine's previous repository, because two repositories
should not look interchangeable.

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

STONE = (239, 233, 224)
STONE_DEEP = (222, 212, 197)
PLUM = (74, 37, 69)
PLUM_MID = (104, 58, 96)
PLUM_DEEP = (52, 24, 48)
CORAL = (232, 101, 79)
CHARTREUSE = (185, 196, 60)
CARD = (252, 249, 244)
CARD_EDGE = (208, 197, 182)

TABS = (CORAL, CHARTREUSE, PLUM_MID, CORAL, PLUM_MID)

# Drawer box, and the lean that turns a flat rectangle into a shallow top-down view.
DRAWER_L, DRAWER_R = 132.0, 1360.0
DRAWER_T, DRAWER_B = 214.0, 656.0
LEAN = 68.0
CARDS = 13
GAP = 6.0
PULLED_INDEX = CARDS - 4

OUT = Path(__file__).resolve().parent.parent / "assets" / "banner.png"


def s(value: float) -> int:
    return int(round(value * SCALE))


def layer() -> Image.Image:
    return Image.new("RGBA", (W, H), (0, 0, 0, 0))


def card_shape(x: float, y: float, w: float, h: float, lean: float) -> list[tuple[int, int]]:
    """A card face: the top edge shifted sideways against the bottom edge."""
    return [
        (s(x + lean), s(y)),
        (s(x + w + lean), s(y)),
        (s(x + w), s(y + h)),
        (s(x), s(y + h)),
    ]


def drop_shadow(canvas: Image.Image, shape: list[tuple[int, int]], offset: float, blur: float, alpha: int) -> None:
    """A soft shadow beneath a cut shape, so the layers read as paper."""
    shadow = layer()
    ImageDraw.Draw(shadow).polygon(
        [(x + s(offset), y + s(offset * 1.6)) for x, y in shape], fill=(58, 38, 30, alpha)
    )
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(s(blur))))


def paper_grain(image: Image.Image, strength: float = 6.0) -> Image.Image:
    noise = Image.effect_noise((W, H), strength).convert("L").filter(ImageFilter.GaussianBlur(0.5))
    overlay = Image.new("RGBA", (W, H), (92, 76, 54, 0))
    overlay.putalpha(noise.point(lambda v: int(abs(v - 128) * 0.22)))
    return Image.alpha_composite(image, overlay)


def shadowed_polygon(canvas: Image.Image, shape: list[tuple[int, int]], fill, offset=8.0, blur=8.0, alpha=54, width=0, outline=None):
    drop_shadow(canvas, shape, offset, blur, alpha)
    ImageDraw.Draw(canvas).polygon(shape, fill=fill, outline=outline, width=width)


def draw_drawer(canvas: Image.Image) -> tuple[float, float]:
    """The drawer box. Returns the x and width of the filing area."""
    outer = [
        (s(DRAWER_L + LEAN), s(DRAWER_T)),
        (s(DRAWER_R + LEAN), s(DRAWER_T)),
        (s(DRAWER_R), s(DRAWER_B)),
        (s(DRAWER_L), s(DRAWER_B)),
    ]
    shadowed_polygon(canvas, outer, STONE_DEEP, offset=11, blur=10, alpha=52, width=s(4), outline=PLUM)

    inset = 22.0
    well = [
        (s(DRAWER_L + LEAN + inset * 0.9), s(DRAWER_T + inset)),
        (s(DRAWER_R + LEAN - inset), s(DRAWER_T + inset)),
        (s(DRAWER_R - inset * 0.9), s(DRAWER_B - inset)),
        (s(DRAWER_L + inset), s(DRAWER_B - inset)),
    ]
    ImageDraw.Draw(canvas).polygon(well, fill=PLUM_DEEP, outline=PLUM, width=s(2))
    return DRAWER_L + inset + 6.0, DRAWER_R - DRAWER_L - inset * 2 - 14.0


def draw_filed_cards(canvas: Image.Image, slot_x: float, slot_w: float) -> float:
    """The packed cards, minus the one that will be drawn out. Returns its x."""
    inner_t, inner_b = DRAWER_T + 38.0, DRAWER_B - 28.0
    card_h = inner_b - inner_t
    step = slot_w / CARDS
    card_w = step - GAP
    rng = random.Random(20260915)

    for index in range(CARDS):
        x = slot_x + index * step
        jitter = rng.uniform(-3.0, 3.0)
        shape = card_shape(x, inner_t + jitter, card_w, card_h, LEAN)

        if index == PULLED_INDEX:
            ImageDraw.Draw(canvas).polygon(shape, fill=PLUM_DEEP)
            continue

        shadowed_polygon(canvas, shape, CARD, offset=3, blur=3, alpha=48, width=s(1.5), outline=CARD_EDGE)
        cd = ImageDraw.Draw(canvas)

        for row in range(7):
            t = (row + 0.9) / 7.7
            y = inner_t + jitter + card_h * t
            at_y = LEAN * (1.0 - (y - inner_t) / card_h)
            lx = x + card_w * 0.16 + at_y
            cd.rounded_rectangle(
                (s(lx), s(y), s(lx + card_w * rng.uniform(0.40, 0.70)), s(y + 2.6)),
                radius=s(1.3),
                fill=PLUM,
            )

        tab_w, tab_h = card_w * 0.46, 17.0
        tab_x = x + (card_w - tab_w) / 2 + LEAN
        cd.rectangle(
            (s(tab_x), s(inner_t + jitter - tab_h), s(tab_x + tab_w), s(inner_t + jitter)),
            fill=TABS[index % len(TABS)],
        )

    return slot_x + PULLED_INDEX * step


def draw_pulled_card(canvas: Image.Image, x: float, card_w: float) -> None:
    """One card drawn up out of the row, standing proud, carrying a stamp."""
    face_w = card_w + 16.0
    # Lifted straight up out of its slot: the bottom edge clears the filed row,
    # the top rises well above the drawer. A card floating mid-air reads as a
    # mistake rather than as a card being drawn.
    lift = 156.0
    bottom = DRAWER_B - 28.0 - lift
    face_h = 452.0
    top = bottom - face_h
    shape = card_shape(x - 8.0, top, face_w, face_h, LEAN)

    shadowed_polygon(canvas, shape, CARD, offset=15, blur=14, alpha=76, width=s(3), outline=PLUM)
    cd = ImageDraw.Draw(canvas)

    tab_w, tab_h = face_w * 0.52, 23.0
    tab_x = x - 8.0 + (face_w - tab_w) / 2 + LEAN
    cd.rectangle((s(tab_x), s(top - tab_h), s(tab_x + tab_w), s(top)), fill=CORAL)

    rng = random.Random(7)
    for row in range(14):
        t = (row + 1.0) / 15.4
        y = top + 74.0 + (face_h - 150.0) * t
        at_y = LEAN * (1.0 - (y - top) / face_h)
        lx = x + 8.0 + at_y
        cd.rounded_rectangle(
            (s(lx), s(y), s(lx + (face_w - 30.0) * rng.uniform(0.45, 0.88)), s(y + 3.0)),
            radius=s(1.5),
            fill=PLUM_MID if row % 3 else PLUM,
        )

    seal_r = 44.0
    cx = x + face_w * 0.60 + LEAN * 0.45
    cy = top + face_h - 92.0
    cd.ellipse((s(cx - seal_r), s(cy - seal_r), s(cx + seal_r), s(cy + seal_r)), fill=CHARTREUSE)
    cd.ellipse(
        (s(cx - seal_r + 7), s(cy - seal_r + 7), s(cx + seal_r - 7), s(cy + seal_r - 7)),
        outline=PLUM, width=s(2.4),
    )
    cd.ellipse(
        (s(cx - seal_r + 17), s(cy - seal_r + 17), s(cx + seal_r - 17), s(cy + seal_r - 17)),
        outline=PLUM, width=s(1.4),
    )


def draw_outflow(canvas: Image.Image) -> None:
    """The copy leaving the drawer, and the sealed archive it becomes."""
    mid_y = (DRAWER_T + DRAWER_B) / 2.0
    start_x = DRAWER_R + LEAN + 6.0
    end_x = 1806.0
    cd = ImageDraw.Draw(canvas)

    steps = 22
    top_edge, bottom_edge = [], []
    for step in range(steps + 1):
        t = step / steps
        x = start_x + t * (end_x - start_x)
        half = 46.0 * (1.0 - t) + 34.0 * t
        top_edge.append((s(x), s(mid_y - half)))
        bottom_edge.append((s(x), s(mid_y + half)))
    ribbon = top_edge + list(reversed(bottom_edge))
    shadowed_polygon(canvas, ribbon, PLUM, offset=6, blur=6, alpha=42)

    for step in range(1, 9):
        t = step / 9.0
        x = start_x + t * (end_x - start_x)
        half = (46.0 * (1.0 - t) + 34.0 * t) * 0.80
        cd.line([(s(x), s(mid_y - half)), (s(x), s(mid_y + half))], fill=STONE, width=s(2.4))

    w, h = 178.0, 392.0
    sealed = [
        (s(end_x), s(mid_y - h / 2)),
        (s(end_x + w), s(mid_y - h / 2)),
        (s(end_x + w), s(mid_y + h / 2)),
        (s(end_x), s(mid_y + h / 2)),
    ]
    shadowed_polygon(canvas, sealed, PLUM_MID, offset=9, blur=8, alpha=54, width=s(2), outline=PLUM)
    for row in range(12):
        y = mid_y - h / 2 + 26.0 + row * ((h - 60.0) / 11.0)
        cd.rounded_rectangle((s(end_x + 26), s(y), s(end_x + w - 26), s(y + 4.0)), radius=s(2), fill=STONE_DEEP)

    seal_r = 46.0
    cx, cy = end_x + w / 2, mid_y + h / 2 - 62.0
    cd.ellipse((s(cx - seal_r), s(cy - seal_r), s(cx + seal_r), s(cy + seal_r)), fill=CHARTREUSE)
    cd.ellipse(
        (s(cx - seal_r + 8), s(cy - seal_r + 8), s(cx + seal_r - 8), s(cy + seal_r - 8)),
        outline=PLUM, width=s(2.2),
    )


def draw_banner() -> Image.Image:
    base = Image.new("RGBA", (W, H), STONE + (255,))
    slot_x, slot_w = draw_drawer(base)
    pulled_x = draw_filed_cards(base, slot_x, slot_w)
    draw_pulled_card(base, pulled_x, slot_w / CARDS - GAP)
    draw_outflow(base)
    return paper_grain(base).convert("RGB").resize((WIDTH, HEIGHT), Image.LANCZOS)


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    image = draw_banner()
    image.save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT}  {image.size[0]}x{image.size[1]}  {OUT.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
