"""Split a dense table image into overlapping vertical slices for vision OCR."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("--out", required=True)
    parser.add_argument("--slices", type=int, default=2)
    parser.add_argument("--overlap", type=float, default=0.08)
    parser.add_argument("--max-width", type=int, default=1800)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = Path(args.input)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    image = Image.open(source).convert("RGB")
    width, height = image.size
    count = max(2, min(8, int(args.slices)))
    overlap = max(20, int(height * max(0.02, min(0.2, args.overlap))))
    base = math.ceil(height / count)
    paths = []
    for index in range(count):
        top = max(0, index * base - (overlap if index else 0))
        bottom = min(height, (index + 1) * base + (overlap if index < count - 1 else 0))
        crop = image.crop((0, top, width, bottom))
        if crop.width > args.max_width:
            ratio = args.max_width / crop.width
            crop = crop.resize(
                (args.max_width, max(1, round(crop.height * ratio))),
                Image.Resampling.LANCZOS,
            )
        path = out_dir / f"{source.stem}-slice-{index + 1:02d}.webp"
        crop.save(path, "WEBP", quality=90, method=6)
        paths.append(str(path))
    print(json.dumps({"source": str(source), "size": [width, height], "slices": paths}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
