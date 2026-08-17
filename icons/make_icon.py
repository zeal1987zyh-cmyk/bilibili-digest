#!/usr/bin/env python3
"""生成 B站深度阅读助手 扩展图标（无水印，干净矢量风格）"""
import math
from PIL import Image, ImageDraw

SIZES = [16, 32, 48, 128]
COLORS = {
    "top": (251, 114, 153),      # B站粉 #FB7299
    "bottom": (108, 92, 231),    # 靛紫 #6C5CE7
    "white": (255, 255, 255),
}


def rounded_rect(draw, xy, radius, fill):
    draw.rounded_rectangle(xy, radius=radius, fill=fill)


def draw_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    r = size * 0.22  # 圆角半径

    # 渐变背景（线性插值）
    for y in range(size):
        ratio = y / (size - 1)
        c = tuple(int(COLORS["top"][i] * (1 - ratio) + COLORS["bottom"][i] * ratio) for i in range(3))
        draw.line([(0, y), (size, y)], fill=c)

    # 白色文档轮廓
    pad = int(size * 0.22)
    doc_l = pad
    doc_t = int(size * 0.18)
    doc_r = size - pad
    doc_b = size - int(size * 0.22)
    rr = int(size * 0.06)
    rounded_rect(draw, (doc_l, doc_t, doc_r, doc_b), rr, COLORS["white"])

    # 文档内部镂空（用背景色画一个稍小的圆角矩形）
    inner_pad = max(1, int(size * 0.035))
    rounded_rect(
        draw,
        (doc_l + inner_pad, doc_t + inner_pad, doc_r - inner_pad, doc_b - inner_pad),
        max(1, rr - inner_pad),
        (COLORS["top"][0], COLORS["top"][1], COLORS["top"][2], 255),
    )

    # 重新为内部窗口填充渐变（避免背景色覆盖导致透明问题）
    for y in range(doc_t + inner_pad, doc_b - inner_pad):
        ratio = y / (size - 1)
        c = tuple(int(COLORS["top"][i] * (1 - ratio) + COLORS["bottom"][i] * ratio) for i in range(3))
        draw.line(
            [(doc_l + inner_pad, y), (doc_r - inner_pad, y)],
            fill=c,
        )

    # 文档内文字行
    line_w = (doc_r - doc_l) - int(size * 0.14)
    line_h = max(1, int(size * 0.045))
    line_x = doc_l + int(size * 0.07)
    gap = int(size * 0.08)
    base_y = doc_t + int(size * 0.18)
    for i in range(3):
        y = base_y + i * gap
        draw.rounded_rectangle(
            (line_x, y, line_x + line_w, y + line_h),
            radius=line_h // 2,
            fill=COLORS["white"],
        )

    # 播放三角形覆盖在左侧
    tri_pad = int(size * 0.32)
    cx = tri_pad + int(size * 0.08)
    cy = size // 2
    tri_r = int(size * 0.16)
    # 等边三角形，尖端朝右
    pts = [
        (cx - tri_r, cy - int(tri_r * math.sqrt(3) / 2)),
        (cx - tri_r, cy + int(tri_r * math.sqrt(3) / 2)),
        (cx + tri_r, cy),
    ]
    draw.polygon(pts, fill=COLORS["white"])

    return img


if __name__ == "__main__":
    for s in SIZES:
        im = draw_icon(s)
        im.save(f"icon{s}.png", "PNG")
        print(f"icon{s}.png generated")
