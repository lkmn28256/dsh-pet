#!/usr/bin/env python3
"""从 assets/ 现拼一张表情总览图（docs/expressions.png），给 README 当门面。

原则和 tools/preview_bubbles.js 一样：**不在文档里手工贴图**。
图从仓库里那份 assets/ 现拼，素材换了重跑一次就行，README 永远和实际立绘一致。

用法：python tools/make_sheet.py        （需要 Pillow）
"""
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
OUT = os.path.join(ROOT, "docs", "expressions.png")

# 顺序有讲究：第一行是日常最常出现的四个，越往下越少见。
NAMES = [
    "calm", "happy", "sleepy", "cool",
    "surprised", "shy", "calling", "angry",
    "sleeping", "confused", "love", "excited",
]

THUMB_H = 220
COLS, ROWS = 4, 3
PAD = 16
LABEL_H = 26
BG = (22, 20, 34)          # 和 DSH 侧栏的深色底一致
FG = (205, 210, 235)


def thumb(path):
    im = Image.open(path).convert("RGBA")
    scale = THUMB_H / im.height
    return im.resize((max(1, int(round(im.width * scale))), THUMB_H), Image.LANCZOS)


def main():
    thumbs = []
    for name in NAMES:
        p = os.path.join(ASSETS, name + ".png")
        if not os.path.exists(p):
            raise SystemExit("缺少立绘：%s（assets/ 里没有这张，NAMES 要跟着改）" % p)
        thumbs.append(thumb(p))

    cell_w = max(t.width for t in thumbs) + PAD * 2
    cell_h = THUMB_H + LABEL_H + PAD
    W, H = cell_w * COLS, cell_h * ROWS + PAD

    canvas = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(canvas)
    for i, (name, t) in enumerate(zip(NAMES, thumbs)):
        r, c = divmod(i, COLS)
        ox = c * cell_w + (cell_w - t.width) // 2
        oy = PAD + r * cell_h + (THUMB_H - t.height) + PAD // 2
        canvas.paste(t, (ox, oy), t)
        label = "%d. %s" % (i + 1, name)
        d.text((c * cell_w + (cell_w - 90) // 2,
                PAD + r * cell_h + THUMB_H + PAD // 2), label, fill=FG)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    canvas.save(OUT, optimize=True)
    print("saved %s  (%dx%d, %d 字节)" % (OUT, W, H, os.path.getsize(OUT)))


if __name__ == "__main__":
    main()
