#!/usr/bin/env python3
"""Render a MirrorDoc JSON document as a standalone HTML reading page."""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List


def esc(value: Any) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def page_link(page: int) -> str:
    return f"source-pages/page-{page:02d}.png"


def locator(block: Dict[str, Any]) -> str:
    page = int(block.get("page", 0) or 0)
    label = f"p.{page}" if page else ""
    source = ", ".join(block.get("sourceIds", [])[:3])
    return (
        f'<span class="locator" title="source ids: {esc(source)}">'
        f'{esc(label)}'
        + (f' · {esc(source)}' if source else "")
        + "</span>"
    )


def page_badge(block: Dict[str, Any]) -> str:
    page = int(block.get("page", 0) or 0)
    if not page:
        return ""
    return (
        f'<a class="page-badge" href="{esc(page_link(page))}" target="_blank" '
        f'title="打开原版 PDF 第 {page} 页">原版 p.{page}</a>'
    )


def render_asset(block: Dict[str, Any]) -> str:
    kind = block.get("type", "figure")
    asset = block.get("asset", "")
    caption = block.get("caption") or block.get("text") or ""
    label = block.get("label") or ("公式" if kind == "equation" else "")
    caption_text = caption
    if label and caption_text.lower().startswith(label.lower()):
        caption_text = caption_text[len(label) :].lstrip(" .:：")
    if asset:
        image = (
            f'<img src="{esc(asset)}" alt="{esc(caption[:300])}">'
        )
    else:
        image = '<div class="missing-asset">未生成裁剪图</div>'
    if kind == "equation":
        return (
            f'<figure class="asset equation" id="{esc(block.get("id", ""))}">'
            f'{image}<figcaption><span class="asset-label">{esc(label)}</span>'
            f'<span class="asset-note">原样裁剪，待转写为 LaTeX</span></figcaption>'
            f"{page_badge(block)}{locator(block)}</figure>"
        )
    return (
        f'<figure class="asset {esc(kind)}" id="{esc(block.get("id", ""))}">'
        f'{image}<figcaption><span class="asset-label">{esc(label)}</span>'
        f'{esc(caption_text)}</figcaption>'
        f"{page_badge(block)}{locator(block)}</figure>"
    )


def render_block(block: Dict[str, Any]) -> str:
    kind = block.get("type", "paragraph")
    block_id = esc(block.get("id", ""))
    text = block.get("text", "")
    if kind == "title":
        return ""
    if kind == "heading":
        level = min(4, max(2, int(block.get("level", 1)) + 1))
        return (
            f'<h{level} id="{block_id}" class="section-heading">'
            f"{esc(text)}{page_badge(block)}{locator(block)}</h{level}>"
        )
    if kind == "abstract":
        return ""
    if kind == "keywords":
        return ""
    if kind in ("figure", "table", "equation"):
        return render_asset(block)
    if kind == "caption":
        return (
            f'<p class="caption" id="{block_id}">{esc(text)}'
            f"{page_badge(block)}{locator(block)}</p>"
        )
    if kind == "reference":
        return (
            f'<li id="{block_id}" class="reference">{esc(text)}'
            f"{page_badge(block)}{locator(block)}</li>"
        )
    if kind == "code":
        return (
            f'<pre id="{block_id}" class="code"><code>{esc(text)}</code>'
            f"{page_badge(block)}{locator(block)}</pre>"
        )
    return (
        f'<p id="{block_id}" class="prose">{esc(text)}'
        f"{page_badge(block)}{locator(block)}</p>"
    )


def render_html(doc: Dict[str, Any]) -> str:
    meta = doc.get("meta", {})
    version = doc.get("version", {})
    coverage = doc.get("coverage", {})
    blocks: List[Dict[str, Any]] = doc.get("blocks", [])
    outline = doc.get("outline", [])
    title = meta.get("title") or "Untitled paper"
    authors = meta.get("authors") or ""
    abstract = meta.get("abstract") or ""
    keywords = meta.get("keywords") or ""
    doi = meta.get("doi") or ""
    pages = meta.get("pageCount", 0)
    ratio = coverage.get("characterRatio", 0)
    whole_ratio = coverage.get("wholePageRatio", 0)
    roles = coverage.get("roles", {})
    block_types = coverage.get("blockTypes", {})
    asset_kinds = coverage.get("assetKinds", {})
    outline_html = "".join(
        f'<a class="outline-item level-{min(3, int(item.get("level", 1)))}" '
        f'href="#{esc(item.get("blockId", ""))}">{esc(item.get("title", ""))}</a>'
        for item in outline
    )
    body_blocks = []
    in_references = False
    for block in blocks:
        if block.get("type") == "heading" and re.match(
            r"^\s*(?:REFERENCES?|BIBLIOGRAPHY)\s*$", str(block.get("text") or ""), re.I
        ):
            if in_references:
                body_blocks.append("</ol>")
            body_blocks.append(render_block(block))
            body_blocks.append('<ol class="references">')
            in_references = True
            continue
        if in_references and block.get("type") != "reference":
            body_blocks.append("</ol>")
            in_references = False
        body_blocks.append(render_block(block))
    if in_references:
        body_blocks.append("</ol>")
    body = "\n".join(item for item in body_blocks if item)

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)} · HTML 阅读原型</title>
<style>
:root {{
  --paper: #fbf8f1;
  --paper-edge: #e8dfcf;
  --ink: #24211d;
  --muted: #736b60;
  --accent: #2f5d7c;
  --accent-soft: #e2edf3;
  --rule: #d9d0c0;
  --code: #f0e8d9;
  --shadow: 0 10px 30px rgba(36, 33, 29, .07);
}}
* {{ box-sizing: border-box; }}
html {{ scroll-behavior: smooth; }}
body {{
  margin: 0;
  color: var(--ink);
  background: #eee8dc;
  font-family: Georgia, "Times New Roman", "Noto Serif CJK SC", serif;
  line-height: 1.72;
}}
.shell {{ max-width: 1240px; margin: 0 auto; padding: 28px 22px 60px; }}
.topbar {{
  display: flex; align-items: center; justify-content: space-between; gap: 18px;
  padding: 12px 16px; margin-bottom: 22px; background: rgba(251,248,241,.9);
  border: 1px solid var(--paper-edge); border-radius: 14px; box-shadow: var(--shadow);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 13px; color: var(--muted);
}}
.topbar strong {{ color: var(--ink); font-weight: 650; }}
.toggle {{
  border: 1px solid var(--rule); background: var(--paper); color: var(--ink);
  padding: 7px 11px; border-radius: 9px; cursor: pointer; font: inherit;
}}
.toggle:hover {{ background: var(--accent-soft); }}
.layout {{ display: grid; grid-template-columns: 230px minmax(0, 1fr); gap: 28px; align-items: start; }}
.sidebar {{
  position: sticky; top: 18px; max-height: calc(100vh - 36px); overflow: auto;
  padding: 16px; background: var(--paper); border: 1px solid var(--paper-edge);
  border-radius: 14px; box-shadow: var(--shadow);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 13px;
}}
.sidebar h2 {{ font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 0 0 10px; }}
.outline-item {{ display: block; padding: 5px 6px; color: var(--accent); text-decoration: none; border-radius: 6px; }}
.outline-item:hover {{ background: var(--accent-soft); }}
.outline-item.level-2 {{ padding-left: 16px; color: var(--muted); }}
.outline-item.level-3 {{ padding-left: 26px; color: var(--muted); font-size: 12px; }}
.sidebar .stats {{ margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--rule); color: var(--muted); line-height: 1.65; }}
.sidebar .stats b {{ color: var(--ink); }}
.paper {{
  background: var(--paper); border: 1px solid var(--paper-edge); border-radius: 16px;
  box-shadow: var(--shadow); padding: 46px clamp(24px, 6vw, 76px) 64px;
}}
.paper-header {{ border-bottom: 1px solid var(--rule); padding-bottom: 24px; margin-bottom: 28px; }}
.kicker {{
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: var(--accent);
  margin-bottom: 10px;
}}
h1 {{ font-size: clamp(28px, 4vw, 42px); line-height: 1.16; letter-spacing: -.02em; margin: 0 0 12px; }}
.authors {{ color: var(--muted); font-size: 16px; margin: 0 0 14px; }}
.badges {{ display: flex; flex-wrap: wrap; gap: 7px; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 12px; }}
.badge {{ padding: 4px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); }}
.badge.warn {{ background: #f5e7cf; color: #7a4e12; }}
.abstract {{ margin: 0 0 24px; padding: 18px 20px; background: #f5efe3; border-left: 3px solid var(--accent); border-radius: 0 10px 10px 0; }}
.section-kicker {{ font-family: ui-sans-serif, system-ui, sans-serif; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin-bottom: 5px; }}
.abstract p {{ margin: 0; }}
.keywords {{ font-size: 14px; color: var(--muted); margin: -6px 0 30px; }}
.keywords span {{ color: var(--ink); font-weight: 650; }}
.section-heading {{ font-size: clamp(21px, 2.6vw, 29px); line-height: 1.25; margin: 40px 0 14px; letter-spacing: -.01em; scroll-margin-top: 20px; }}
.prose {{ margin: 0 0 16px; font-size: clamp(16px, 1.35vw, 18px); text-align: justify; hyphens: auto; }}
.prose:first-letter {{ }}
.asset {{ margin: 26px 0 28px; padding: 12px; background: #fffdf8; border: 1px solid var(--paper-edge); border-radius: 12px; }}
.asset img {{ display: block; max-width: 100%; height: auto; margin: 0 auto; border-radius: 5px; }}
.asset figcaption {{ margin-top: 10px; color: var(--muted); font-size: 14px; line-height: 1.55; }}
.asset-label {{ color: var(--ink); font-weight: 650; margin-right: 6px; }}
.asset-note {{ margin-left: 8px; color: var(--muted); font-size: 12px; }}
.equation {{ background: #f8f6ef; text-align: center; }}
.equation img {{ max-height: 130px; }}
.missing-asset {{ padding: 30px; text-align: center; color: var(--muted); background: var(--code); border-radius: 8px; }}
.caption {{ color: var(--muted); font-size: 14px; margin: -8px 0 26px; }}
.code {{ white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px 14px; border-radius: 8px;
  background: #f2efe9; border: 1px solid #ddd6ca; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }}
.references {{ list-style: none; padding-left: 0; }}
.reference {{ margin-bottom: 10px; color: #3c3832; font-size: 14px; overflow-wrap: anywhere; }}
.locator {{
  display: none; margin-left: 8px; color: #8b8174; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10px; white-space: nowrap; vertical-align: middle;
}}
.show-locators .locator {{ display: inline; }}
.page-badge {{
  margin-left: 8px; padding: 2px 6px; border: 1px solid var(--rule); border-radius: 999px;
  color: var(--muted); text-decoration: none; font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 10px; white-space: nowrap; vertical-align: middle;
}}
.page-badge:hover {{ color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }}
.footer {{ margin-top: 34px; padding-top: 16px; border-top: 1px solid var(--rule); color: var(--muted); font-size: 12px; font-family: ui-sans-serif, system-ui, sans-serif; }}
@media (max-width: 900px) {{
  .layout {{ grid-template-columns: 1fr; }}
  .sidebar {{ position: relative; top: 0; max-height: none; }}
  .paper {{ padding: 30px 20px 42px; }}
}}
@media print {{
  body {{ background: #fff; }}
  .topbar, .sidebar, .page-badge, .locator {{ display: none !important; }}
  .shell {{ max-width: none; padding: 0; }}
  .layout {{ display: block; }}
  .paper {{ border: 0; box-shadow: none; border-radius: 0; padding: 0; }}
  .asset {{ break-inside: avoid; }}
}}
</style>
</head>
<body>
<div class="shell">
  <div class="topbar">
    <div><strong>HTML 阅读原型</strong> · PDF 提取 + 位置戳 + 重排</div>
    <button class="toggle" id="toggle-locators" type="button">显示位置戳</button>
  </div>
  <div class="layout">
    <aside class="sidebar">
      <h2>Outline</h2>
      {outline_html or '<div class="outline-item">（未识别到章节标题）</div>'}
      <div class="stats">
        <div><b>{pages}</b> 页 · <b>{len(blocks)}</b> 块</div>
        <div>正文覆盖 <b>{ratio * 100:.2f}%</b>（整页 {whole_ratio * 100:.2f}%）</div>
        <div>图 <b>{asset_kinds.get("figure", 0)}</b> · 表 <b>{asset_kinds.get("table", 0)}</b> · 公式 <b>{asset_kinds.get("equation", 0)}</b></div>
        <div>角色：{esc(", ".join(f"{k} {v}" for k, v in roles.items()))}</div>
        <div>块类型：{esc(", ".join(f"{k} {v}" for k, v in block_types.items()))}</div>
      </div>
    </aside>
    <main class="paper">
      <header class="paper-header">
        <div class="kicker">MirrorDoc / HTML reading prototype</div>
        <h1>{esc(title)}</h1>
        <p class="authors">{esc(authors)}</p>
        <div class="badges">
          <span class="badge">PDF · {pages} pages</span>
          <span class="badge">正文覆盖 {ratio * 100:.2f}%</span>
          <span class="badge warn">版本未核验</span>
          {f'<span class="badge">DOI {esc(doi)}</span>' if doi else ''}
          {f'<span class="badge">许可 {esc(meta.get("license", ""))}</span>' if meta.get("license") else ''}
        </div>
      </header>
      {f'<section class="abstract"><div class="section-kicker">Abstract</div><p>{esc(abstract)}</p></section>' if abstract else ''}
      {f'<p class="keywords"><span>Keywords</span> {esc(keywords)}</p>' if keywords else ''}
      {body}
      <footer class="footer">
        由 PDF 文本层、字符坐标与版面规则生成。图/表/公式为原页裁剪，未重新绘制；原版 PDF 作为核对保险，请以原页为准。
      </footer>
    </main>
  </div>
</div>
<script>
const button = document.getElementById('toggle-locators');
if (button) {{
  button.addEventListener('click', () => {{
    const on = document.body.classList.toggle('show-locators');
    button.textContent = on ? '隐藏位置戳' : '显示位置戳';
  }});
}}
</script>
</body>
</html>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mirrordoc", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    doc = json.loads(args.mirrordoc.read_text(encoding="utf-8"))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(render_html(doc), encoding="utf-8")
    print(f"Wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
