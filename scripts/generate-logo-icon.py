"""Generate KomaScope wordmark app icon (512x512 PNG) with Pillow.

Design: dark background, "KomaScope" wordmark in bold white with a
blue (#4a9eff) outline, soft drop shadow and a subtle white→light-blue
vertical gradient fill — matching the app's accent color.

Only the EXE/installer icon (resources/icon.png) uses this wordmark;
the window title-bar icon (resources/window-icon.png) keeps the lucide
"image" open-source icon, rendered by scripts/generate-window-icon.js.

Usage: python scripts/generate-logo-icon.py
Writes resources/icon.png. Requires Pillow: pip install pillow
"""
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont, ImageFilter
except ImportError:
    sys.exit("Pillow 未安装,请先运行: pip install pillow")

SIZE = 512
BG = (18, 18, 18)          # #121212,与现有图标背景一致
ACCENT = (74, 158, 255)    # #4a9eff
TARGET_TEXT_WIDTH = 440    # 文字目标宽度(留出描边/投影余量)


def fit_font(text):
    """按候选字体顺序寻找粗体无衬线字体,并按目标宽度自适应字号。"""
    candidates = [
        "C:/Windows/Fonts/arialbd.ttf",       # Arial Bold
        "C:/Windows/Fonts/msyhbd.ttc",        # 微软雅黑 Bold
        "C:/Windows/Fonts/seguibl.ttf",       # Segoe UI Black
        "C:/Windows/Fonts/impact.ttf",        # Impact(过宽,兜底)
        "/System/Library/Fonts/HelveticaNeue-Bold.ttf",  # macOS 粗体
        "/System/Library/Fonts/Helvetica.ttc",          # macOS 兜底(TTC,可能非粗体)
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",  # Linux
    ]
    for path in candidates:
        if not os.path.exists(path):
            continue
        try:
            probe = ImageFont.truetype(path, 100)
            bbox = probe.getbbox(text)
            width = bbox[2] - bbox[0]
            if width <= 0:
                continue
            size = max(40, int(100 * TARGET_TEXT_WIDTH / width))
            return ImageFont.truetype(path, size), size
        except OSError:
            continue
    sys.exit("未找到可用粗体字体,请手动指定字体路径")


def main():
    text = "KomaScope"
    font, _ = fit_font(text)

    # 全部内容画在透明画布上,便于 getbbox 裁切居中
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # 1) 投影:黑色半透明,向下偏移后高斯模糊
    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    shd = ImageDraw.Draw(shadow)
    shd.text((0, 8), text, font=font, fill=(0, 0, 0, 160), stroke_width=7, stroke_fill=(0, 0, 0, 160))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(6)))

    # 2) 蓝色描边层(比填充层大一圈)
    stroke = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sd = ImageDraw.Draw(stroke)
    sd.text((0, 0), text, font=font, fill=(*ACCENT, 255), stroke_width=14, stroke_fill=(*ACCENT, 255))
    img.alpha_composite(stroke)

    # 3) 白色渐变填充(白 → 浅蓝):用文字 mask 裁出填充层;
    # 渐变限定在文字区域内,避免全屏渐变被文字只取顶部而不可见
    mask = Image.new("L", (SIZE, SIZE), 0)
    md = ImageDraw.Draw(mask)
    md.text((0, 0), text, font=font, fill=255)
    mbox = mask.getbbox() or (0, 0, SIZE, SIZE)
    gradient = Image.new("RGBA", (SIZE, SIZE))
    gd = ImageDraw.Draw(gradient)
    top = (255, 255, 255, 255)
    bottom = (168, 205, 255, 255)
    gy0, gy1 = mbox[1], mbox[3]
    for y in range(gy0, gy1):
        t = (y - gy0) / max(1, gy1 - gy0)
        gd.line(
            [(0, y), (SIZE, y)],
            fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(4)),
        )
    gradient.putalpha(mask)
    img.alpha_composite(gradient)

    # 居中:透明画布上裁出内容 bbox,贴回深色背景中央
    bbox = img.getbbox()
    if bbox:
        art = img.crop(bbox)
        canvas = Image.new("RGBA", (SIZE, SIZE), (*BG, 255))
        x = (SIZE - art.width) // 2
        y = (SIZE - art.height) // 2
        canvas.alpha_composite(art, (x, y))
        img = canvas

    img.save("resources/icon.png")
    print("resources/icon.png written:", os.path.getsize("resources/icon.png"), "bytes")


if __name__ == "__main__":
    main()
