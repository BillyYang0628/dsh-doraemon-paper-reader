#!/usr/bin/env python3
"""把 formulas.json 里的 LaTeX 预渲染成 SVG（matplotlib mathtext）。

为什么不用 KaTeX：插件运行时必须零第三方依赖，不能把 KaTeX 的 JS/CSS 带进来。
这里用本机已有的 matplotlib 在宿主侧生成矢量图，浏览器只拿到 SVG；
失败时保留原图与 LaTeX 源码，不伪造排版。

用法：python 工具/render_formulas.py <jobDir>
产物：<jobDir>/assets/formula-<blockId>.svg + formula-renders.json
"""

import hashlib
import json
import re
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import rcParams

rcParams["mathtext.fontset"] = "cm"
rcParams["svg.fonttype"] = "path"


def sanitize(latex: str):
    value = str(latex or "").replace("\r", "")
    value = re.sub(r"\\tag\{[^}]*\}", "", value)
    value = re.sub(r"\\begin\{[^}]+\}|\\end\{[^}]+\}", "", value)
    value = re.sub(r"\\text\{([^{}]*)\}", r"\\mathrm{\1}", value)
    value = value.replace("&", "")
    # 以未转义的 \\ 分成多行；mathtext 不支持 align 环境。
    parts = re.split(r"\\\\", value)
    lines = []
    for part in parts:
        line = part.strip().strip("$").strip()
        if line:
            lines.append(line)
    return lines


def render_svg(latex: str, out: Path):
    lines = sanitize(latex)
    if not lines:
        raise ValueError("empty-latex")
    height = 0.85 * len(lines) + 0.45
    fig = plt.figure(figsize=(7.2, height), dpi=200)
    fig.patch.set_facecolor("white")
    for index, line in enumerate(lines):
        y = 1 - (index + 0.5) / len(lines)
        fig.text(
            0.5,
            y,
            f"${line}$",
            ha="center",
            va="center",
            fontsize=20,
            color="#10101A",
        )
    fig.savefig(out, format="svg", bbox_inches="tight", pad_inches=0.08, facecolor="white")
    plt.close(fig)


def main():
    if len(sys.argv) < 2:
        print("usage: render_formulas.py <jobDir>", file=sys.stderr)
        return 2
    job_dir = Path(sys.argv[1]).resolve()
    formulas_path = job_dir / "formulas.json"
    if not formulas_path.is_file():
        print(json.dumps({"ok": False, "error": "formulas.json not found"}))
        return 0
    formulas = json.loads(formulas_path.read_text(encoding="utf-8"))
    assets = job_dir / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    manifest_path = assets / "formula-renders.json"
    manifest = {}
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            manifest = {}
    renders = {}
    for block_id, block in (formulas.get("blocks") or {}).items():
        latex = str(block.get("latex") or "")
        if not block.get("valid") or not latex:
            renders[block_id] = {"ok": False, "error": "invalid-or-empty"}
            continue
        digest = hashlib.sha1(latex.encode("utf-8")).hexdigest()
        filename = f"formula-{block_id}.svg"
        out = assets / filename
        cached = manifest.get(block_id) or {}
        if cached.get("hash") == digest and cached.get("ok") and out.is_file():
            renders[block_id] = {**cached, "cached": True}
            continue
        try:
            render_svg(latex, out)
            record = {
                "ok": True,
                "file": f"assets/{filename}",
                "hash": digest,
                "label": block.get("label") or "",
                "confidence": block.get("confidence"),
            }
        except Exception as error:  # noqa: BLE001 - 单条公式失败不应影响其他公式
            record = {"ok": False, "hash": digest, "error": str(error)[:300]}
        renders[block_id] = record
        manifest[block_id] = record
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "renders": renders}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
