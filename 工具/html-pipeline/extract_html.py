#!/usr/bin/env python3
"""arXiv/ar5iv HTML -> MirrorDoc.

This is deliberately a small, dependency-free extractor for the structural
HTML that arXiv emits (`ltx_section`, `ltx_figure`, `ltx_table`,
`ltx_equation`, `ltx_bibitem`). It is not a general web scraper: the host
only feeds it a locally saved arXiv/ar5iv page.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import urljoin


VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}


class Node:
    def __init__(self, tag: str, attrs: Dict[str, str], parent: Optional["Node"] = None):
        self.tag = tag
        self.attrs = attrs
        self.parent = parent
        self.children: List[Any] = []

    def classes(self) -> set[str]:
        return set((self.attrs.get("class") or "").split())

    def has_class(self, name: str) -> bool:
        return name in self.classes()

    def attr(self, name: str, default: str = "") -> str:
        return self.attrs.get(name, default)

    def descendants(self) -> Iterable["Node"]:
        for child in self.children:
            if isinstance(child, Node):
                yield child
                yield from child.descendants()

    def find(self, tag: Optional[str] = None, cls: Optional[str] = None) -> Optional["Node"]:
        for node in self.descendants():
            if tag is not None and node.tag != tag:
                continue
            if cls is not None and not node.has_class(cls):
                continue
            return node
        return None

    def find_all(self, tag: Optional[str] = None, cls: Optional[str] = None) -> List["Node"]:
        out = []
        for node in self.descendants():
            if tag is not None and node.tag != tag:
                continue
            if cls is not None and not node.has_class(cls):
                continue
            out.append(node)
        return out


class TreeParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#document", {})
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag.lower(), {str(k).lower(): str(v or "") for k, v in attrs}, self.stack[-1])
        self.stack[-1].children.append(node)
        if tag.lower() not in VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        node = Node(tag.lower(), {str(k).lower(): str(v or "") for k, v in attrs}, self.stack[-1])
        self.stack[-1].children.append(node)

    def handle_endtag(self, tag):
        tag = tag.lower()
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return

    def handle_data(self, data):
        if data:
            self.stack[-1].children.append(data)


def normalize(text: str, keep_newlines: bool = False) -> str:
    text = unescape(str(text or "")).replace("\u00ad", "")
    text = re.sub(r"[ \t]+", " ", text)
    if keep_newlines:
        text = re.sub(r" *\n *", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()
    return re.sub(r"\s+", " ", text).strip()


def node_text(node: Optional[Node], keep_newlines: bool = False) -> str:
    if node is None:
        return ""
    parts: List[str] = []

    def walk(value):
        if isinstance(value, str):
            parts.append(value)
            return
        if not isinstance(value, Node):
            return
        if value.tag in {"script", "style", "nav", "header", "footer"}:
            return
        if value.tag == "math":
            alt = value.attr("alttext")
            if alt:
                parts.append(" " + alt + " ")
                return
        if value.tag == "img":
            alt = value.attr("alt")
            if alt and alt != "Refer to caption":
                parts.append(" " + alt + " ")
            return
        if value.tag == "br":
            parts.append("\n")
            return
        for child in value.children:
            walk(child)

    walk(node)
    return normalize("".join(parts), keep_newlines=keep_newlines)


def first_text(node: Optional[Node]) -> str:
    return node_text(node)


def label_from_caption(caption: str, fallback: str) -> str:
    match = re.search(r"\b((?:Figure|Fig\.?|Table|Algorithm|Equation|Eq\.?)\s*[A-Za-z0-9.\-–]+)", caption)
    return match.group(1).rstrip(".:") if match else fallback


def find_heading(section: Node) -> Optional[Node]:
    for child in section.children:
        if not isinstance(child, Node):
            continue
        if child.tag in {"h1", "h2", "h3", "h4", "h5", "h6"} and child.has_class("ltx_title"):
            return child
    return section.find(cls="ltx_title_section") or section.find(cls="ltx_title_subsection")


def table_text(node: Node) -> str:
    rows: List[str] = []
    for row in node.find_all("tr"):
        cells = []
        for cell in row.children:
            if isinstance(cell, Node) and cell.tag in {"td", "th"}:
                value = node_text(cell)
                if value:
                    cells.append(value)
        if cells:
            rows.append(" | ".join(cells))
    return "\n".join(rows)


def equation_text(node: Node) -> str:
    maths = [item.attr("alttext") for item in node.find_all("math") if item.attr("alttext")]
    if maths:
        return " ; ".join(maths)
    return node_text(node)


def image_url(node: Node, base_url: str) -> str:
    for candidate in node.descendants():
        if candidate.tag == "img" and candidate.attr("src"):
            return urljoin(base_url, candidate.attr("src"))
        if candidate.tag == "object" and candidate.attr("data"):
            return urljoin(base_url, candidate.attr("data"))
    return ""


def build_blocks(article: Node, base_url: str) -> (List[Dict[str, Any]], List[Dict[str, Any]], str, str):
    blocks: List[Dict[str, Any]] = []
    assets: List[Dict[str, Any]] = []
    section = ""
    section_stack: List[str] = []
    seen_nodes: set[int] = set()
    source_chars = 0
    mapped_chars = 0
    figure_index = 0
    table_index = 0
    equation_index = 0
    reference_index = 0

    def push_heading(text: str, level: int):
        nonlocal section
        text = normalize(text)
        if not text:
            return
        while len(section_stack) >= level:
            section_stack.pop()
        section_stack.append(text)
        section = " / ".join(section_stack)
        blocks.append({
            "type": "heading",
            "level": max(1, min(4, level)),
            "text": text,
            "section": section,
            "page": 0,
        })

    def walk(node: Node):
        nonlocal source_chars, mapped_chars, figure_index, table_index, equation_index, reference_index
        if id(node) in seen_nodes:
            return
        if node.tag in {"nav", "header", "footer", "script", "style"}:
            return
        classes = node.classes()

        if node.has_class("ltx_title_document") or node.has_class("ltx_authors"):
            return
        if node.has_class("ltx_abstract"):
            return

        if "ltx_figure" in classes or "ltx_table" in classes:
            caption_node = node.find(cls="ltx_caption")
            caption = node_text(caption_node)
            if "ltx_table" in classes:
                table_index += 1
                body = table_text(node)
                label = label_from_caption(caption, f"Table {table_index}")
                text = (caption + ("\n" + body if body else "")).strip()
            else:
                figure_index += 1
                label = label_from_caption(caption, f"Figure {figure_index}")
                text = caption
                url = image_url(node, base_url)
                if url:
                    assets.append({"kind": "figure", "source": url, "label": label})
            source_chars += len(node_text(node, keep_newlines=True))
            mapped_chars += len(text)
            blocks.append({
                "type": "table" if "ltx_table" in classes else "figure",
                "label": label,
                "caption": caption or label,
                "text": text,
                "assetSource": assets[-1]["source"] if assets and assets[-1].get("label") == label else "",
                "section": section,
                "page": 0,
            })
            seen_nodes.add(id(node))
            return

        if node.has_class("ltx_equation"):
            equation_index += 1
            body = equation_text(node)
            label = f"Equation {equation_index}"
            tag = node.find(cls="ltx_tag_equation")
            if tag and node_text(tag):
                label = label_from_caption(node_text(tag), label)
            source_chars += len(node_text(node, keep_newlines=True))
            mapped_chars += len(body)
            blocks.append({
                "type": "equation",
                "label": label,
                "caption": "",
                "text": body,
                "section": section,
                "page": 0,
            })
            seen_nodes.add(id(node))
            return

        if node.tag == "li" and node.has_class("ltx_bibitem"):
            reference_index += 1
            body = node_text(node, keep_newlines=True)
            source_chars += len(body)
            mapped_chars += len(body)
            blocks.append({
                "type": "reference",
                "label": f"Reference {reference_index}",
                "text": body,
                "section": "References",
                "page": 0,
            })
            seen_nodes.add(id(node))
            return

        if node.tag in {"h1", "h2", "h3", "h4", "h5"} and "ltx_title" in classes:
            raw = node_text(node)
            level = {"h1": 1, "h2": 1, "h3": 2, "h4": 3, "h5": 4}.get(node.tag, 1)
            if raw:
                push_heading(raw, level)
            return

        if node.tag == "p" and ("ltx_p" in classes or node.parent is not None and node.parent.has_class("ltx_para")):
            body = node_text(node, keep_newlines=True)
            if body and not re.fullmatch(r"\d{1,4}", body):
                source_chars += len(body)
                mapped_chars += len(body)
                blocks.append({
                    "type": "paragraph",
                    "text": body,
                    "section": section,
                    "page": 0,
                })
            seen_nodes.add(id(node))
            return

        for child in node.children:
            if isinstance(child, Node):
                walk(child)

    walk(article)
    return blocks, assets, source_chars, mapped_chars


def build_brief(blocks: List[Dict[str, Any]], abstract: str, keywords: str) -> Dict[str, Any]:
    sections = []
    section = ""
    gist = []
    figures = []
    tables = []
    equations = []
    references = 0
    for block in blocks:
        if block["type"] == "heading":
            if section and gist:
                sections.append({"heading": section, "page": 0, "gist": " ".join(gist)[:280]})
            section = block["text"]
            gist = []
        elif block["type"] == "paragraph" and section and len(" ".join(gist)) < 280:
            gist.append(block.get("text", ""))
        elif block["type"] == "figure":
            figures.append({"label": block.get("label", ""), "page": 0, "caption": block.get("caption", "")})
        elif block["type"] == "table":
            tables.append({"label": block.get("label", ""), "page": 0, "caption": block.get("caption", "")})
        elif block["type"] == "equation":
            equations.append({"label": block.get("label", ""), "page": 0, "text": block.get("text", "")})
        elif block["type"] == "reference":
            references += 1
    if section and gist:
        sections.append({"heading": section, "page": 0, "gist": " ".join(gist)[:280]})
    return {
        "abstract": abstract,
        "keywords": keywords,
        "sections": sections[:12],
        "figures": figures[:12],
        "tables": tables[:8],
        "equations": equations[:8],
        "referenceCount": references,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("html", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--base-url", default="")
    parser.add_argument("--meta", type=Path)
    parser.add_argument("--progress", action="store_true")
    args = parser.parse_args()

    def progress(stage: str, message: str):
        if args.progress:
            print("DPR_PROGRESS " + json.dumps({"stage": stage, "message": message}, ensure_ascii=False), file=sys.stderr, flush=True)

    progress("extract", "小的我正在读 arXiv HTML…")
    source = args.html.read_text(encoding="utf-8", errors="replace")
    external = json.loads(args.meta.read_text(encoding="utf-8")) if args.meta and args.meta.exists() else {}
    tree = TreeParser()
    tree.feed(source)
    article = tree.root.find("article") or tree.root.find(cls="ltx_document") or tree.root
    base_url = args.base_url or external.get("sourceUrl") or ""

    title_node = article.find(cls="ltx_title_document") or tree.root.find("title")
    title = normalize(external.get("title") or first_text(title_node))
    authors_node = article.find(cls="ltx_authors")
    authors = external.get("authors") or first_text(authors_node)
    if isinstance(authors, list):
        authors = ", ".join(authors)
    abstract_node = article.find(cls="ltx_abstract")
    abstract = normalize(external.get("abstract") or first_text(abstract_node))
    keywords_node = article.find(cls="ltx_keywords")
    keywords = normalize(external.get("keywords") or first_text(keywords_node))

    blocks, assets, source_chars, mapped_chars = build_blocks(article, base_url)
    for index, block in enumerate(blocks):
        block["id"] = f"b{index:04d}"
        if block.get("assetSource"):
            for asset in assets:
                if asset.get("label") == block.get("label") and not asset.get("blockId"):
                    asset["blockId"] = block["id"]
                    asset["name"] = f"figure-{len([a for a in assets if a.get('blockId')]):02d}{Path(asset['source'].split('?')[0]).suffix or '.png'}"
                    break
    outline = [
        {"id": block["id"], "level": block.get("level", 1), "title": block["text"], "blockId": block["id"]}
        for block in blocks if block["type"] == "heading"
    ]
    brief = build_brief(blocks, abstract, keywords)
    meta = {
        "title": title,
        "authors": authors,
        "doi": external.get("doi", ""),
        "arxivId": external.get("arxiv", ""),
        "abstract": abstract,
        "keywords": keywords,
        "pageCount": 0,
        "license": external.get("license", ""),
        "brief": brief,
        "generatedAt": external.get("generatedAt", ""),
        "sha256": external.get("sha256", ""),
    }
    doc = {
        "schemaVersion": 1,
        "docId": "arxiv-" + hashlib.sha256(source.encode("utf-8")).hexdigest()[:12],
        "meta": meta,
        "version": external.get("version") or {"kind": "preprint", "label": "arXiv 预印本", "source": "arxiv"},
        "provenance": external.get("provenance") or {"mirrorKind": "html", "channel": {"route": "arxiv-html"}},
        "outline": outline,
        "blocks": blocks,
        "assets": assets,
        "coverage": {
            "sourceChars": source_chars,
            "mappedChars": mapped_chars,
            "characterRatio": min(1.0, mapped_chars / source_chars) if source_chars else 0,
            "blockTypes": {kind: len([b for b in blocks if b["type"] == kind]) for kind in sorted({b["type"] for b in blocks})},
            "assetKinds": {"figure": len(assets)},
            "notes": ["HTML 无物理页码，page=0；阅读页按 section 定位。"],
        },
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "mirrordoc.json").write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = {
        "title": title,
        "authors": authors,
        "identifiers": {"doi": external.get("doi", ""), "arxiv": external.get("arxiv", "")},
        **brief,
        "generatedAt": external.get("generatedAt", ""),
    }
    (args.out / "paper-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (args.out / "report.md").write_text(
        "\n".join([
            "# HTML 摄取报告",
            "",
            f"- source: `{args.html}`",
            f"- title: {title}",
            f"- blocks: {len(blocks)}",
            f"- assets: {len(assets)}",
            f"- source chars: {source_chars}",
            f"- mapped chars: {mapped_chars}",
            f"- coverage: {doc['coverage']['characterRatio'] * 100:.2f}%",
        ]) + "\n",
        encoding="utf-8",
    )
    progress("extract", f"HTML 结构整理完成：{len(blocks)} 块，{len(assets)} 个图")
    print(json.dumps({"out": str(args.out), "blocks": len(blocks), "assets": len(assets)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
