# -*- coding: utf-8 -*-
"""生成截屏OCR专属图标 icon.ico（多尺寸）。

设计：蓝色渐变圆角底 + 白色取景框四角 + 三条文字线，表达「截屏 + 文字识别」。
用法：python scripts/make_icon.py
"""
from PIL import Image, ImageDraw


def lerp(c1, c2, t):
    return tuple(round(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))


def draw(size):
    top = (72, 133, 244)      # #4885F4
    bottom = (26, 71, 200)    # #1A47C8
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 垂直渐变背景
    for y in range(size):
        c = lerp(top, bottom, y / max(1, size - 1))
        d.line([(0, y), (size, y)], fill=c + (255,))
    # 圆角裁剪
    alpha = Image.new("L", (size, size), 0)
    ImageDraw.Draw(alpha).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
    img.putalpha(alpha)

    fg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fg)
    w = max(2, int(size * 0.045))   # 线宽
    m = int(size * 0.16)            # 角标外距
    L = int(size * 0.24)            # 角标长度
    W = (255, 255, 255, 255)
    hw = w // 2
    # 四角取景框（截屏选框）
    # 左上
    fd.line([(m, m + hw), (m + L, m + hw)], fill=W, width=w)
    fd.line([(m + hw, m), (m + hw, m + L)], fill=W, width=w)
    # 右上
    fd.line([(size - m - L, m + hw), (size - m, m + hw)], fill=W, width=w)
    fd.line([(size - m - hw, m), (size - m - hw, m + L)], fill=W, width=w)
    # 左下
    fd.line([(m, size - m - hw), (m + L, size - m - hw)], fill=W, width=w)
    fd.line([(m + hw, size - m - L), (m + hw, size - m)], fill=W, width=w)
    # 右下
    fd.line([(size - m - L, size - m - hw), (size - m, size - m - hw)], fill=W, width=w)
    fd.line([(size - m - hw, size - m - L), (size - m - hw, size - m)], fill=W, width=w)

    # 三条文字线（识别出的文字）
    line_h = max(2, int(size * 0.055))
    cx = size // 2
    fracs = [0.46, 0.38, 0.26]
    y0 = int(size * 0.42)
    gap = int(size * 0.10)
    for i, frac in enumerate(fracs):
        lw = int(size * frac)
        y = y0 + i * (line_h + gap)
        fd.rounded_rectangle(
            [cx - lw // 2, y, cx + lw // 2, y + line_h], radius=line_h // 2, fill=W)

    return Image.alpha_composite(img, fg)


def main():
    sizes = [256, 128, 64, 48, 32, 24, 16]
    imgs = [draw(s) for s in sizes]
    out = "assets/icon.ico"
    import os
    os.makedirs("assets", exist_ok=True)
    imgs[0].save(out, format="ICO",
                 sizes=[(s, s) for s in sizes], append_images=imgs[1:])
    print("已生成", out, "尺寸", sizes)


if __name__ == "__main__":
    main()
