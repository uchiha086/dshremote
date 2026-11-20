"""生成 DSH Remote 的应用图标（background / foreground / startIcon）。"""
from PIL import Image, ImageDraw, ImageFont
import math

SIZE = 1024
FONT = "C:/Windows/Fonts/segoeuib.ttf"
OUT = "C:/Users/user/Desktop/dshremote/tools/icon-out"

import os
os.makedirs(OUT, exist_ok=True)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def background():
    img = Image.new("RGB", (SIZE, SIZE))
    px = img.load()
    top = (11, 18, 38)
    bottom = (24, 44, 92)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        c = lerp(top, bottom, t ** 0.9)
        for x in range(SIZE):
            px[x, y] = c
    d = ImageDraw.Draw(img, "RGBA")
    # 细网格，给一点"工程"感
    step = 128
    for x in range(0, SIZE, step):
        d.line([(x, 0), (x, SIZE)], fill=(255, 255, 255, 12), width=2)
    for y in range(0, SIZE, step):
        d.line([(0, y), (SIZE, y)], fill=(255, 255, 255, 12), width=2)
    # 右上角光晕
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for r in range(620, 0, -10):
        alpha = int(46 * (1 - r / 620))
        gd.ellipse([SIZE - 180 - r, -140 - r, SIZE - 180 + r, -140 + r], fill=(90, 150, 255, alpha))
    img = Image.alpha_composite(img.convert("RGBA"), glow)
    return img


def glyph(size, text="DSH", accent=True):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, int(size * 0.30))
    bbox = d.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    x = (size - w) / 2 - bbox[0]
    y = (size - h) / 2 - bbox[1] - int(size * 0.04)
    # 文字阴影
    d.text((x + size * 0.012, y + size * 0.012), text, font=font, fill=(0, 0, 0, 90))
    d.text((x, y), text, font=font, fill=(255, 255, 255, 255))
    if accent:
        # 下划线：一条渐变短线，暗示"终端光标"
        bar_w = int(w * 0.62)
        bar_h = int(size * 0.022)
        bx = (size - bar_w) / 2
        by = y + h + int(size * 0.115)
        for i in range(bar_w):
            t = i / max(1, bar_w - 1)
            c = lerp((80, 170, 255), (150, 220, 255), t)
            d.line([(bx + i, by), (bx + i, by + bar_h)], fill=c + (255,))
    return img


bg = background()
bg.save(f"{OUT}/background.png")

fg = glyph(SIZE)
fg.save(f"{OUT}/foreground.png")

start = glyph(SIZE, accent=True)
start.save(f"{OUT}/startIcon.png")

# 预览：合成一张 1024 图，方便肉眼确认
preview = Image.alpha_composite(bg.copy(), fg)
preview.convert("RGB").resize((256, 256)).save(f"{OUT}/preview.png")
print("ok")
