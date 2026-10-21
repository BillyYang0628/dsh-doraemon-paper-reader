#!/usr/bin/env python3
"""Optional third-pass AI order audit for a MirrorDoc.

This pass is advisory only: it reads a compact section/paragraph outline and
reports ordering problems. It never rewrites the document. Deterministic
checks in ``reconcile_layout.py`` remain the source of truth.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List


MAX_OUTLINE_CHARS = 9000
MAX_SECTIONS = 40
MAX_PARAGRAPHS_PER_SECTION = 2


def _clean(value: Any, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit] + ("…" if len(text) > limit else "")


def load_api_key() -> str:
    """Read the key from the environment or $DSH_HOME/.env without printing it."""
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if key:
        return key
    home = os.environ.get("DSH_HOME", "").strip()
    if not home:
        return ""
    env_path = Path(home) / ".env"
    if not env_path.is_file():
        return ""
    for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name.strip() == "DEEPSEEK_API_KEY":
            return value.strip().strip("\"'")
    return ""


def build_outline(doc: Dict[str, Any]) -> str:
    """Build a compact reading-order outline (headings + section openings)."""
    blocks: List[Dict[str, Any]] = list(doc.get("blocks") or [])
    meta = doc.get("meta") or {}
    lines: List[str] = [
        f"TITLE: {_clean(meta.get('title'), 240)}",
        f"AUTHORS: {_clean(meta.get('authors'), 240)}",
        f"DOI: {meta.get('doi') or ''}",
        "",
    ]
    section = 0
    paragraph_count = 0
    reference_count = 0
    reference_numbers: List[int] = []
    for block in blocks:
        kind = block.get("type")
        text = block.get("text") or block.get("caption") or ""
        if kind == "heading":
            section += 1
            if section > MAX_SECTIONS:
                lines.append("… (more sections omitted)")
                break
            level = max(1, min(4, int(block.get("level") or 1)))
            indent = "  " * (level - 1)
            lines.append(
                f"\n{indent}[SECTION {section}] [H{level}] {_clean(text, 160)} "
                f"(p.{block.get('page') or '?'})"
            )
            paragraph_count = 0
            continue
        if kind == "reference":
            reference_count += 1
            match = re.match(r"^\s*\[?(\d{1,4})[\].)]", str(text))
            if match:
                reference_numbers.append(int(match.group(1)))
            if reference_count <= 2 or reference_count >= 999:
                lines.append(f"  REF: {_clean(text, 150)}")
            continue
        if kind in ("paragraph", "caption", "code"):
            if paragraph_count >= MAX_PARAGRAPHS_PER_SECTION:
                continue
            paragraph_count += 1
            lines.append(f"  {kind.upper()}: {_clean(text, 260)}")
    if reference_numbers:
        lines.append(
            f"\nREFERENCE SUMMARY: {reference_count} entries; "
            f"first={reference_numbers[0]}, last={reference_numbers[-1]}"
        )
    outline = "\n".join(lines)
    return outline[:MAX_OUTLINE_CHARS]


def _extract_json(text: str) -> Dict[str, Any]:
    value = str(text or "").strip()
    value = re.sub(r"^```(?:json)?\s*", "", value, flags=re.I)
    value = re.sub(r"\s*```$", "", value)
    start = value.find("{")
    end = value.rfind("}")
    if start >= 0 and end > start:
        value = value[start : end + 1]
    return json.loads(value)


def request_audit(outline: str, api_key: str, model: str) -> Dict[str, Any]:
    prompt = (
        "你是论文版面顺序审校器。下面是从 PDF 重建的章节/段落顺序摘要。"
        "只检查顺序，不评价内容质量，不改写正文：\n"
        "1) 正文章节是否符合常见论文逻辑（允许期刊差异）；\n"
        "2) SUPPORTING INFORMATION 是否在 REFERENCES 之前；\n"
        "3) 编号参考文献是否连续、是否都归在 REFERENCES 之后；\n"
        "4) ACKNOWLEDGMENTS / Author Contributions / Funding / Data Availability "
        "是否在全部参考文献之后；\n"
        "5) 是否有章节被拆散、重复或夹在错误位置。\n"
        "缩进与 [H1]/[H2]/[H3]/[H4] 表示标题层级：H2/H3/H4 属于上一节，"
        "不要把子标题当成独立的一级章节。Funding / Data Availability 可能出现在"
        "首页元数据或 Acknowledgments 内；只要没有在错误位置出现，缺失不算顺序错误。\n"
        "REFERENCES 下只展示前 2 条是压缩摘要，不代表其余编号缺失；"
        "编号范围以 REFERENCE SUMMARY 的 first/last 为准。\n"
        "本项目采用的后置顺序是：正文 → SUPPORTING INFORMATION → REFERENCES → "
        "ACKNOWLEDGMENTS / Author Contributions。不要把这一目标顺序判成错误；"
        "也不要把 H1 下直接出现 H3 子节当成顺序错误（期刊模板允许跳级）。\n"
        '只输出 JSON：{"ok": true|false, "issues": [{"severity": "error|warning", '
        '"where": "章节或位置", "reason": "一句话说明"}]}。没有问题时 issues 为空。\n\n'
        + outline
    )
    payload = {
        "model": model,
        "temperature": 0,
        "max_tokens": 700,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": "你只做论文顺序审校，输出严格 JSON。"},
            {"role": "user", "content": prompt},
        ],
    }
    request = urllib.request.Request(
        "https://api.deepseek.com/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + api_key,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=75) as response:
        body = json.loads(response.read().decode("utf-8"))
    content = body["choices"][0]["message"]["content"]
    return _extract_json(content)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job", type=Path, help="job directory containing mirrordoc.json")
    parser.add_argument("--model", default="deepseek-chat")
    parser.add_argument("--outline-only", action="store_true", help="write the compact outline and skip the API call")
    args = parser.parse_args()

    doc_path = args.job / "mirrordoc.json"
    if not doc_path.is_file():
        print("missing mirrordoc.json: " + str(doc_path), file=sys.stderr)
        return 2
    doc = json.loads(doc_path.read_text(encoding="utf-8"))
    outline = build_outline(doc)
    audit_dir = args.job / "audit"
    audit_dir.mkdir(exist_ok=True)
    (audit_dir / "ai-order-input.txt").write_text(outline, encoding="utf-8")
    if args.outline_only:
        print(json.dumps({"outline": str(audit_dir / "ai-order-input.txt"), "chars": len(outline)}, ensure_ascii=False))
        return 0

    api_key = load_api_key()
    if not api_key:
        print(
            json.dumps(
                {"skipped": "DEEPSEEK_API_KEY not found; outline written for manual/model review"},
                ensure_ascii=False,
            )
        )
        return 0
    try:
        report = request_audit(outline, api_key, args.model)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, KeyError) as error:
        print(json.dumps({"error": str(error), "outline": str(audit_dir / "ai-order-input.txt")}, ensure_ascii=False))
        return 1
    report = {
        "ok": bool(report.get("ok")),
        "issues": list(report.get("issues") or []),
        "model": args.model,
        "outlineChars": len(outline),
    }
    (audit_dir / "ai-order-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
