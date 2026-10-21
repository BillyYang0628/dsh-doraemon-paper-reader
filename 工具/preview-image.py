"""给"要进模型上下文的图"瘦身：生成压缩预览图，需要时再拼一张对比联系表。

为什么必须有这一步（2026-10-16 实测，见 决定台账 D-016）：
- DeepSeek 的 Responses API 是**无状态**的：每发一次采样请求，都要把整段会话历史重传一遍；
  官方文档写明请求体上限 **48 MiB**，内联 base64 图片计入其中。
- 出图产物是 2048×2048 的 PNG（单张约 5.7 MB）。直接 view_image 一张，上下文里就多约 4 MiB
  base64，而且**永久驻留、每轮重传**——"生成→看图→再生成"的循环在第 11 张左右就会把会话顶爆
  （413 Payload Too Large，重试 5 次全失败，回合直接报错）。
- 同一个 768px WebP 只有约 110 KB（-98%），评审造型细节（帽形、披风长度、像素风格）足够看清。

用法：
    python 工具/preview-image.py <文件或目录...> [选项]

选项：
    --out DIR      输出目录（默认：第一个输入所在目录下的 preview/）
    --max-side N   长边像素上限（默认 768）
    --format F     webp / jpeg / png（默认 webp；jpeg 会去掉透明通道）
    --quality Q    有损格式的质量（默认 80）
    --max-kb N     源文件小于该值就跳过，不重复处理（默认 300）
    --sheet N      额外拼一张每行 N 张的联系表（同样压缩输出）
    --quiet        只打印预览清单

输出：`preview/` 下的压缩图 + 一份可以直接喂 view_image 的路径清单。
依赖：Pillow（本机 D:\\Python 已可用；缺失时会给出明确提示，不静默降级）。
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="把图压成适合进模型上下文的预览图（默认 768px WebP）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("inputs", nargs="+", help="图片文件或目录（目录递归）")
    parser.add_argument("--out", default=None, help="输出目录")
    parser.add_argument("--max-side", type=int, default=768, help="长边像素上限（默认 768）")
    parser.add_argument("--format", default="webp", choices=["webp", "jpeg", "png"])
    parser.add_argument("--quality", type=int, default=80, help="有损质量，1-100")
    parser.add_argument("--max-kb", type=int, default=300, help="源文件小于该值就跳过")
    parser.add_argument("--sheet", type=int, default=0, help="拼联系表：每行 N 张")
    parser.add_argument("--quiet", action="store_true", help="只打印清单")
    return parser.parse_args()


def load_pillow():
    try:
        from PIL import Image  # noqa: PLC0415  (延迟导入以便给出友好提示)
    except ImportError:
        sys.exit(
            "缺少 Pillow。请用装了 Pillow 的解释器运行（本机 D:\\Python 已可用），"
            "或先 `pip install pillow` 到自管 venv（AGENTS.md §2.2：不动系统 Python）。"
        )
    resample = getattr(Image, "Resampling", Image).LANCZOS
    return Image, resample


def collect_images(inputs: list[str], out_dir: Path) -> list[Path]:
    found: list[Path] = []
    out_resolved = out_dir.resolve()
    for raw in inputs:
        path = Path(raw).expanduser()
        if path.is_dir():
            for child in sorted(path.rglob("*")):
                if not child.is_file() or child.suffix.lower() not in IMAGE_EXTS:
                    continue
                if out_resolved in child.resolve().parents:
                    continue  # 不处理自己产出的预览
                if child.name.startswith("."):
                    continue
                found.append(child)
        elif path.is_file():
            found.append(path)
        else:
            sys.exit(f"输入不存在：{path}")
    if not found:
        sys.exit("没找到任何图片。")
    return found


def save_preview(Image, src: Path, dst: Path, max_side: int, fmt: str, quality: int) -> None:
    im = Image.open(src)
    if fmt == "jpeg":
        im = im.convert("RGB")
    else:
        im = im.copy()
    im.thumbnail((max_side, max_side), getattr(Image, "Resampling", Image).LANCZOS)
    if fmt == "webp":
        im.save(dst, "WEBP", quality=quality, method=6)
    elif fmt == "jpeg":
        im.save(dst, "JPEG", quality=quality, optimize=True)
    else:
        if im.mode == "RGBA":
            im.save(dst, "PNG", optimize=True)
        else:
            im.save(dst, "PNG", optimize=True)


def make_sheet(Image, paths: list[Path], dst: Path, cols: int, max_width: int, quality: int) -> None:
    cell = max(200, min(512, max_width // cols))
    rows = (len(paths) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * cell), (255, 255, 255))
    for i, path in enumerate(paths):
        im = Image.open(path).convert("RGBA")
        im.thumbnail((cell - 8, cell - 8), getattr(Image, "Resampling", Image).LANCZOS)
        x = (i % cols) * cell + (cell - im.width) // 2
        y = (i // cols) * cell + (cell - im.height) // 2
        sheet.paste(im, (x, y), im)
    if sheet.width > max_width:
        ratio = max_width / sheet.width
        sheet = sheet.resize(
            (max_width, max(1, round(sheet.height * ratio))),
            getattr(Image, "Resampling", Image).LANCZOS,
        )
    sheet.save(dst, "WEBP", quality=quality, method=6)


def main() -> int:
    args = parse_args()
    Image, _resample = load_pillow()

    first = Path(args.inputs[0]).expanduser()
    base_dir = first if first.is_dir() else first.parent
    out_dir = Path(args.out).expanduser() if args.out else base_dir / "preview"
    out_dir.mkdir(parents=True, exist_ok=True)

    fmt = args.format
    ext = {"webp": ".webp", "jpeg": ".jpg", "png": ".png"}[fmt]
    sources = collect_images(args.inputs, out_dir)

    produced: list[Path] = []
    skipped: list[Path] = []
    failures: list[tuple[Path, str]] = []
    total_kb = 0.0

    for src in sources:
        dst = out_dir / f"{src.stem}_{args.max_side}{ext}"
        if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
            produced.append(dst)
            total_kb += dst.stat().st_size / 1024
            if not args.quiet:
                print(f"  cached  {dst.name:44s} {dst.stat().st_size / 1024:8.0f} KB")
            continue
        src_kb = src.stat().st_size / 1024
        if src_kb <= args.max_kb:
            skipped.append(src)
            produced.append(src)
            total_kb += src_kb
            if not args.quiet:
                print(f"  keep    {src.name:44s} {src_kb:8.0f} KB  (已小于 {args.max_kb} KB，直接用原图)")
            continue
        try:
            save_preview(Image, src, dst, args.max_side, fmt, args.quality)
        except Exception as exc:  # noqa: BLE001  (逐张报告，不让一张坏图中断整批)
            failures.append((src, str(exc)))
            continue
        dst_kb = dst.stat().st_size / 1024
        total_kb += dst_kb
        produced.append(dst)
        if not args.quiet:
            print(
                f"  {int(src_kb / 1024):>3d} MiB -> {dst_kb:8.0f} KB"
                f"  {100 - dst_kb * 100 / src_kb:5.1f}% smaller   {dst.name}"
            )

    if args.sheet:
        sheet_path = out_dir / f"sheet-{args.sheet}up-{args.max_side}.webp"
        make_sheet(Image, produced, sheet_path, args.sheet, 1536, args.quality)
        sheet_kb = sheet_path.stat().st_size / 1024
        total_kb += sheet_kb
        print(f"  contact sheet -> {sheet_kb:.0f} KB   {sheet_path}")

    print()
    print(f"预览清单（共 {len(produced)} 项，合计 {total_kb / 1024:.2f} MiB）——只把下面这些喂 view_image，原图留盘：")
    for path in produced:
        print(str(path))
    if skipped:
        print(f"\n（其中 {len(skipped)} 张本身就很小，直接用了原图）")
    if failures:
        print("\n失败项：")
        for src, err in failures:
            print(f"  {src}: {err}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
