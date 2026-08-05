"""Generate KomaScope app icon (512x512 PNG) using only stdlib (zlib + struct).

Design: dark background, a comic page (rounded white rect with panel lines),
and a blue speech bubble with tail — evoking a comic reader.
"""
import struct
import zlib

SIZE = 512
BG = (18, 18, 18)          # #121212
PAGE = (240, 240, 240)     # paper
PANEL = (74, 158, 255)     # #4a9eff accent
BUBBLE = (74, 158, 255)
INK = (30, 30, 30)


def lerp(a, b, t):
    return a + (b - a) * t


def in_rounded_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = max(x0 + r, min(x, x1 - r))
    cy = max(y0 + r, min(y, y1 - r))
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_bubble(x, y):
    # main ellipse
    ex, ey, erx, ery = 300, 300, 105, 78
    if ((x - ex) / erx) ** 2 + ((y - ey) / ery) ** 2 <= 1:
        return True
    # tail triangle
    if 270 <= x <= 380 and 345 <= y <= 430:
        t = (x - 270) / 110
        top = lerp(360, 430, t)
        bot = 430
        if top <= y <= bot:
            return True
    return False


def main():
    rows = []
    for y in range(SIZE):
        row = bytearray()
        for x in range(SIZE):
            color = BG
            # comic page (rounded rect, slightly rotated illusion via inset)
            if in_rounded_rect(x, y, 96, 88, 416, 424, 28):
                color = PAGE
                # panel lines
                if (130 <= x <= 140 and 88 <= y <= 424) or (382 <= x <= 392 and 88 <= y <= 424):
                    color = PANEL
                if (96 <= x <= 416 and 150 <= y <= 160) or (96 <= x <= 416 and 320 <= y <= 330):
                    color = PANEL
            # speech bubble on the page
            if in_bubble(x, y):
                color = BUBBLE
            # little dots inside bubble (text hint)
            if color == BUBBLE:
                for (bx, by) in [(282, 292), (300, 292), (318, 292)]:
                    if (x - bx) ** 2 + (y - by) ** 2 <= 7 * 7:
                        color = INK
            row.extend(color)
        rows.append(bytes(row))

    raw = b"".join(rows)
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open("resources/icon.png", "wb") as f:
        f.write(png)
    print("resources/icon.png written:", len(png), "bytes")


if __name__ == "__main__":
    main()
