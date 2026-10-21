"""从样张实测提取色板 + 计算 WCAG 对比度，给界面规范提供可复现的数值依据。

为什么要有这一步（AGENTS.md §2.1 真实性优先 / K5 别靠肉眼）：
"主色调"这类结论必须能复现。人眼从一张 2048px 图上"看着像 #4D6BFE"是不可靠的，
这里直接对像素做中位切分量化，再去掉背景色、合并近似色，输出带占比的色板。

用法：
    python 工具/palette.py <图...> [--colors 24] [--top 16] [--merge 24] [--bg-tol 32]
    python 工具/palette.py --contrast "#1B2A5B:#F5EADD" --contrast "#FFFFFF:#2B7FD4"

选项：
    --colors N   量化色数（默认 24）
    --top N      输出前 N 个非背景色（默认 16）
    --merge N    近似色合并阈值（RGB 曼哈顿距离，默认 24；0 = 不合并）
    --bg-tol N   与背景色的距离阈值，超过即视为背景并剔除（默认 32）
    --json       以 JSON 输出，便于写进文档或脚本

对比度模式：--contrast "前景:背景"（可重复），按 WCAG 2.1 算相对亮度比。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image


def to_hex(rgb: tuple[int, int, int]) -> str:
    return "#{:02X}{:02X}{:02X}".format(*rgb)


def parse_hex(value: str) -> tuple[int, int, int]:
    text = value.strip().lstrip("#")
    if len(text) != 6:
        raise argparse.ArgumentTypeError(f"颜色要 6 位十六进制：{value}")
    return tuple(int(text[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def dist(a: tuple[int, int, int], b: tuple[int, int, int]) -> int:
    return abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])


def relative_luminance(rgb: tuple[int, int, int]) -> float:
    def channel(value: int) -> float:
        srgb = value / 255
        return srgb / 12.92 if srgb <= 0.04045 else ((srgb + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(fg: tuple[int, int, int], bg: tuple[int, int, int]) -> float:
    lf, lb = relative_luminance(fg), relative_luminance(bg)
    lighter, darker = max(lf, lb), min(lf, lb)
    return (lighter + 0.05) / (darker + 0.05)


def border_background(im: Image.Image, ring_ratio: float = 0.03) -> tuple[int, int, int]:
    """用最外圈像素的均值估计背景色（样张几乎都是纯色背景）。"""
    w, h = im.size
    band = max(2, round(min(w, h) * ring_ratio))
    strips = [
        im.crop((0, 0, w, band)),
        im.crop((0, h - band, w, h)),
        im.crop((0, 0, band, h)),
        im.crop((w - band, 0, w, h)),
    ]
    total = [0, 0, 0]
    pixels = 0
    for strip in strips:
        data = strip.getdata()
        for px in data:
            total[0] += px[0]
            total[1] += px[1]
            total[2] += px[2]
            pixels += 1
    return (total[0] // pixels, total[1] // pixels, total[2] // pixels)  # type: ignore[return-value]


def extract(path: Path, colors: int, top: int, merge: int, bg_tol: int) -> dict:
    im = Image.open(path).convert("RGB")
    bg = border_background(im)
    quant = im.quantize(colors=colors, method=Image.MEDIANCUT)
    palette = quant.getpalette() or []
    entries = []
    for count, index in quant.getcolors() or []:
        rgb = tuple(palette[index * 3 : index * 3 + 3])
        if len(rgb) != 3:
            continue
        if dist(rgb, bg) <= bg_tol:
            continue
        entries.append([rgb, count])
    entries.sort(key=lambda item: item[1], reverse=True)

    merged: list[list] = []
    for rgb, count in entries:
        for slot in merged:
            if dist(slot[0], rgb) <= merge:
                slot[1] += count
                break
        else:
            merged.append([rgb, count])
    merged.sort(key=lambda item: item[1], reverse=True)

    total = sum(item[1] for item in merged) or 1
    rows = [
        {
            "hex": to_hex(rgb),
            "rgb": list(rgb),
            "count": count,
            "share": round(count * 100 / total, 2),
            "relative_luminance": round(relative_luminance(rgb), 4),
        }
        for rgb, count in merged[:top]
    ]
    return {"image": str(path), "size": list(im.size), "background": to_hex(bg), "colors": rows}


HUE_BINS = [
    ("红", 345, 15),
    ("橙", 15, 45),
    ("黄/金", 45, 70),
    ("绿", 70, 165),
    ("青", 165, 200),
    ("蓝", 200, 255),
    ("紫", 255, 290),
    ("粉/品红", 290, 345),
]


def hue_bin(hue: float) -> str | None:
    for name, start, end in HUE_BINS:
        if start <= hue < end or (start > end and (hue >= start or hue < end)):
            return name
    return None


def extract_accents(path: Path, min_sat: int = 60, min_val: int = 40) -> dict:
    """按色相分桶找点缀色：红鼻头、金线这类小面积颜色，中位切分量化会把它们并掉。

    做法是逐像素筛高饱和像素，再在色相桶内用粗色立方（每通道 >>3）统计出现最多的颜色。
    """
    try:
        import numpy as np
    except ImportError:  # pragma: no cover
        sys.exit("点缀色提取需要 numpy（本机 D:\\Python 已可用）")

    im = Image.open(path).convert("RGB")
    hsv = np.asarray(im.convert("HSV"), dtype=np.uint8)
    rgb = np.asarray(im, dtype=np.uint8)
    hue, sat, val = hsv[..., 0].astype(np.int16), hsv[..., 1].astype(np.int16), hsv[..., 2].astype(np.int16)
    mask = (sat >= min_sat) & (val >= min_val)
    bg = np.array(border_background(im), dtype=np.int16)
    distance = np.abs(rgb.astype(np.int16) - bg).sum(axis=-1)
    mask &= distance > 32  # 剔除背景（及其纸纹抖动）
    if not mask.any():
        return {}

    hue_deg = hue[mask].astype(np.float64) * 360.0 / 255.0
    pixels = rgb[mask]
    coarse = (pixels >> 3).astype(np.int32)
    keys = coarse[..., 0] * 1024 + coarse[..., 1] * 32 + coarse[..., 2]

    total = int(mask.sum())
    result: dict[str, list[dict]] = {}
    for name, start, end in HUE_BINS:
        if start > end:  # 跨 0 度的红桶
            in_bin = (hue_deg >= start) | (hue_deg < end)
        else:
            in_bin = (hue_deg >= start) & (hue_deg < end)
        if not in_bin.any():
            continue
        bin_keys = keys[in_bin]
        uniq, counts = np.unique(bin_keys, return_counts=True)
        order = np.argsort(counts)[::-1][:3]
        rows = []
        for index in order:
            centroid = coarse[in_bin][bin_keys == uniq[index]].mean(axis=0)
            picked = tuple(int(min(255, round(c * 8 + 4))) for c in centroid)
            rows.append(
                {
                    "hex": to_hex(picked),
                    "count": int(counts[index]),
                    "share": round(int(counts[index]) * 100 / total, 2),
                }
            )
        result[name] = rows
    return result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="实测提取色板 / 计算 WCAG 对比度")
    parser.add_argument("images", nargs="*", help="样张路径")
    parser.add_argument("--colors", type=int, default=24)
    parser.add_argument("--top", type=int, default=16)
    parser.add_argument("--merge", type=int, default=24)
    parser.add_argument("--bg-tol", type=int, default=32)
    parser.add_argument("--contrast", action="append", default=[], help='"前景:背景"，如 "#FFFFFF:#2B7FD4"')
    parser.add_argument(
        "--accents",
        action="store_true",
        help="按色相分桶找点缀色（红鼻头、金线这类占比极小的颜色，普通量化会漏掉）",
    )
    parser.add_argument("--min-sat", type=int, default=60, help="点缀色提取的饱和度下限（0-255，默认 60）")
    parser.add_argument("--min-val", type=int, default=40, help="点缀色提取的明度下限（0-255，默认 40）")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv[1:])

    if args.contrast:
        results = []
        for pair in args.contrast:
            if ":" not in pair:
                sys.exit(f"--contrast 要写成 '#前景:#背景'：{pair}")
            fg_text, bg_text = pair.split(":", 1)
            fg, bg = parse_hex(fg_text), parse_hex(bg_text)
            ratio = contrast_ratio(fg, bg)
            verdict = "AAA" if ratio >= 7 else "AA" if ratio >= 4.5 else "AA-large" if ratio >= 3 else "FAIL"
            results.append({"fg": to_hex(fg), "bg": to_hex(bg), "ratio": round(ratio, 2), "wcag": verdict})
        if args.json:
            print(json.dumps(results, ensure_ascii=False, indent=2))
        else:
            for row in results:
                print(f"{row['fg']} on {row['bg']}  {row['ratio']:5.2f}:1  {row['wcag']}")
        if not args.images:
            return 0

    if not args.images:
        parser.print_help()
        return 2

    payload = [
        extract(Path(raw), args.colors, args.top, args.merge, args.bg_tol) for raw in args.images
    ]
    if args.accents:
        for item in payload:
            item["accents"] = extract_accents(Path(item["image"]), args.min_sat, args.min_val)
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        for item in payload:
            print(f"\n{item['image']}  {item['size'][0]}x{item['size'][1]}  背景 {item['background']}")
            print(f"{'色值':9s} {'占比':>7s}  {'亮度':>6s}")
            for row in item["colors"]:
                print(f"{row['hex']:9s} {row['share']:6.2f}%  {row['relative_luminance']:6.3f}")
            for name, rows in item.get("accents", {}).items():
                detail = "  ".join(f"{row['hex']}({row['share']:.2f}%)" for row in rows)
                print(f"  [{name}] {detail}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
