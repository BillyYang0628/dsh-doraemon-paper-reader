#!/usr/bin/env python
"""把大图导出成界面用的 Web 资产（裁剪 + 缩放 + 压成 WebP）。

为什么要有这个脚本：界面里的插画必须是「可再生成」的产物——
源图（2048×2048 PNG，约 5 MB）不进仓库，进仓库的是它的小号 Web 资产。
每一次导出都用同一条命令，别手工缩图（手工缩放会带进不可复现的差异）。

用法：

    python 工具/export-asset.py UI/mascot-v1.png assets/mascot/mascot-hello-smile-c.webp --size 512 [--cutout]

    --size N    输出边长（正方形，源图非正方形时按最长边居中裁切）
    --cutout    把四边连通的米白背景抠成透明（从边框做洪水填充，不碰角色内部的白色）
    --quality Q WebP 质量，默认 92
"""

import argparse
import sys
from collections import deque

from PIL import Image


def background_color(image):
    """取四角 5% 区域的中位色当作背景色。"""
    width, height = image.size
    patch = max(1, int(min(width, height) * 0.05))
    corners = [
        image.crop((0, 0, patch, patch)),
        image.crop((width - patch, 0, width, patch)),
        image.crop((0, height - patch, patch, height)),
        image.crop((width - patch, height - patch, width, height)),
    ]
    samples = [channel for corner in corners for channel in corner.convert("RGB").getdata()]
    channels = []
    for index in range(3):
        values = sorted(sample[index] for sample in samples)
        channels.append(values[len(values) // 2])
    return tuple(channels)


def cut_out_background(image, tolerance=22):
    """把与边框连通、且接近背景色的像素置为透明（角色内部的浅色不动）。"""
    width, height = image.size
    pixels = image.load()
    background = background_color(image)

    def is_background(color):
        return all(abs(color[index] - background[index]) <= tolerance for index in range(3))

    seen = bytearray(width * height)
    queue = deque()
    for x in range(width):
        for y in (0, height - 1):
            if not seen[y * width + x] and is_background(pixels[x, y]):
                seen[y * width + x] = 1
                queue.append((x, y))
    for y in range(height):
        for x in (0, width - 1):
            if not seen[y * width + x] and is_background(pixels[x, y]):
                seen[y * width + x] = 1
                queue.append((x, y))
    while queue:
        x, y = queue.popleft()
        pixels[x, y] = (0, 0, 0, 0)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < width and 0 <= ny < height and not seen[ny * width + nx]:
                if is_background(pixels[nx, ny]):
                    seen[ny * width + nx] = 1
                    queue.append((nx, ny))
    return image


def square_crop(image):
    """按内容盒裁到正方形：抠图后用 alpha 定盒，否则用「非背景」定盒。"""
    alpha = image.getchannel("A")
    if alpha.getextrema()[0] < 255:
        box = alpha.getbbox()
    else:
        # 没抠图：用「离背景色足够远」的像素定内容盒
        background = background_color(image)
        source = image.convert("RGB").load()
        mask = Image.new("L", image.size, 0)
        target = mask.load()
        for y in range(image.size[1]):
            for x in range(image.size[0]):
                color = source[x, y]
                target[x, y] = (
                    0
                    if all(abs(color[index] - background[index]) <= 22 for index in range(3))
                    else 255
                )
        box = mask.getbbox()
    if box is None:
        raise SystemExit("没找到内容盒：源图可能整张都是背景色")
    left, top, right, bottom = box
    width = right - left
    height = bottom - top
    side = max(width, height)
    # 留 3% 呼吸位，避免角色贴边
    side = int(side * 1.06)
    center_x = (left + right) // 2
    center_y = (top + bottom) // 2
    crop = (
        max(0, center_x - side // 2),
        max(0, center_y - side // 2),
        min(image.size[0], center_x + side // 2),
        min(image.size[1], center_y + side // 2),
    )
    return image.crop(crop)


def main(argv):
    parser = argparse.ArgumentParser(description="导出界面用 Web 资产")
    parser.add_argument("source")
    parser.add_argument("target")
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--quality", type=int, default=92)
    parser.add_argument("--cutout", action="store_true")
    args = parser.parse_args(argv)

    image = Image.open(args.source).convert("RGBA")
    if args.cutout:
        image = cut_out_background(image)
    image = square_crop(image)
    image = image.resize((args.size, args.size), Image.LANCZOS)
    image.save(args.target, "WEBP", quality=args.quality, method=6)

    import os

    print(
        "%s -> %s (%d×%d, %.1f KB)"
        % (args.source, args.target, args.size, args.size, os.path.getsize(args.target) / 1024)
    )


if __name__ == "__main__":
    main(sys.argv[1:])
