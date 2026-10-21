#!/usr/bin/env python3
"""Run the fixed PDF extraction regression corpus.

The corpus intentionally resolves source PDFs by paper title in the local DSH
job store instead of hard-coding volatile job identifiers. Each case runs the
real extraction + reconciliation pipeline into an output directory and checks
structural, ordering, text-quality, and key-content expectations.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List


HERE = Path(__file__).resolve().parent
DEFAULT_CASES = HERE / "regression_cases.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="PDF extraction regression corpus")
    parser.add_argument("--cases", default=str(DEFAULT_CASES), help="cases JSON")
    parser.add_argument(
        "--out",
        default=str(Path("工具") / "gen" / "pdf-regression-20261020"),
        help="output directory",
    )
    parser.add_argument(
        "--source",
        action="append",
        default=[],
        help="name=/path/to/paper.pdf; may be repeated",
    )
    parser.add_argument("--dsh-home", default=os.environ.get("DSH_HOME", r"D:\DSH\home"))
    parser.add_argument("--case", action="append", default=[], help="run only these case ids")
    parser.add_argument("--keep-going", action="store_true", help="run all cases and report all failures")
    return parser.parse_args()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_by_title(title: str, dsh_home: str) -> Path | None:
    jobs = Path(dsh_home) / "doraemon-paper-reader" / "jobs"
    if not jobs.is_dir():
        return None
    hits: List[Path] = []
    needle = title.lower()
    for entry in jobs.iterdir():
        summary = entry / "paper-summary.json"
        pdf = entry / "original.pdf"
        if not summary.is_file() or not pdf.is_file():
            continue
        try:
            title_value = str(load_json(summary).get("title") or "").lower()
        except Exception:
            continue
        if needle in title_value:
            hits.append(pdf)
    if not hits:
        return None
    return max(hits, key=lambda path: path.stat().st_mtime)


def resolve_sources(cases: List[Dict[str, Any]], args: argparse.Namespace) -> Dict[str, Path]:
    sources: Dict[str, Path] = {}
    for raw in args.source:
        if "=" not in raw:
            raise SystemExit("--source 必须是 name=/path 形式：" + raw)
        name, value = raw.split("=", 1)
        path = Path(value).expanduser()
        if not path.is_file():
            raise SystemExit("样本不存在：" + str(path))
        sources[name] = path
    resolved: Dict[str, Path] = {}
    for case in cases:
        case_id = str(case["id"])
        if case_id in sources:
            resolved[case_id] = sources[case_id]
            continue
        found = resolve_by_title(str(case["titleIncludes"]), args.dsh_home)
        if not found:
            raise SystemExit(
                "无法按标题找到样本："
                + case_id
                + " / "
                + str(case["titleIncludes"])
                + "；可用 --source "
                + case_id
                + "=<pdf> 指定"
            )
        resolved[case_id] = found
    return resolved


def run_case(case: Dict[str, Any], pdf: Path, out_root: Path) -> Dict[str, Any]:
    case_dir = out_root / str(case["id"])
    case_dir.mkdir(parents=True, exist_ok=True)
    errors: List[str] = []
    extractor = HERE / "extract_pdf.py"
    reconciler = HERE / "reconcile_layout.py"
    auditor = HERE / "audit_structure.py"
    subprocess.run(
        [sys.executable, str(extractor), str(pdf), "--out", str(case_dir), "--dpi", "150"],
        check=True,
        cwd=HERE.parent.parent,
    )
    subprocess.run(
        [sys.executable, str(reconciler), str(case_dir)],
        check=True,
        cwd=HERE.parent.parent,
    )
    audit_dir = case_dir / "structure-audit"
    subprocess.run(
        [
            sys.executable,
            str(auditor),
            str(case_dir),
            "--out",
            str(audit_dir),
            "--fail-on",
            "never",
        ],
        check=True,
        cwd=HERE.parent.parent,
    )
    doc = load_json(case_dir / "mirrordoc.json")
    layout = load_json(case_dir / "layout-report.json")
    structure_audit = load_json(audit_dir / "audit-report.json")
    blocks = doc.get("blocks") or []
    expect = case.get("expect") or {}

    pages = int((doc.get("meta") or {}).get("pageCount") or 0)
    if pages != int(expect.get("pages", pages)):
        errors.append(f"pages {pages} != {expect.get('pages')}")

    counts: Dict[str, int] = {}
    for block in blocks:
        kind = str(block.get("type") or "")
        counts[kind] = counts.get(kind, 0) + 1
    for kind, wanted in (expect.get("blockTypes") or {}).items():
        if counts.get(kind, 0) != int(wanted):
            errors.append(f"blockTypes.{kind} {counts.get(kind, 0)} != {wanted}")
    for kind, minimum in (expect.get("minBlockTypes") or {}).items():
        if counts.get(kind, 0) < int(minimum):
            errors.append(f"blockTypes.{kind} {counts.get(kind, 0)} < {minimum}")

    references = [block for block in blocks if block.get("type") == "reference"]
    if expect.get("referenceRange"):
        start, end = [int(value) for value in expect["referenceRange"]]
        numbers = []
        for block in references:
            match = re.match(r"\s*(\d+)[.)]\s+", str(block.get("text") or ""))
            if match:
                numbers.append(int(match.group(1)))
        if numbers != list(range(start, end + 1)):
            errors.append(f"reference numbers {numbers[:3]}..{numbers[-3:]} != {start}..{end}")

    warnings = layout.get("warnings") or []
    expected_warnings = expect.get("warnings")
    if expected_warnings is not None and warnings != expected_warnings:
        errors.append("layout warnings: " + json.dumps(warnings, ensure_ascii=False))
    text_quality = layout.get("textQuality") or []
    if "textQuality" in expect and text_quality != expect["textQuality"]:
        errors.append("textQuality: " + json.dumps(text_quality, ensure_ascii=False))

    all_text = "\n".join(
        [str((doc.get("meta") or {}).get("title") or "")]
        + [str(block.get("text") or block.get("caption") or "") for block in blocks]
    )
    prose_text = "\n".join(
        [str((doc.get("meta") or {}).get("title") or "")]
        + [
            str(block.get("text") or block.get("caption") or "")
            for block in blocks
            if block.get("type") != "equation"
        ]
    )
    for needle in expect.get("requiredText") or []:
        if str(needle) not in all_text:
            errors.append("missing text: " + str(needle))
    for needle in expect.get("forbiddenText") or []:
        if str(needle) in prose_text:
            errors.append("forbidden text: " + str(needle))
    if expect.get("rotatedTableText"):
        rotated_tables = [
            block for block in blocks if block.get("type") == "table" and block.get("rotatedPage")
        ]
        if not rotated_tables:
            errors.append("no rotated table blocks for rotatedTableText check")
        for block in rotated_tables:
            text = str(block.get("tableText") or "")
            if "Strain" not in text or "\n" not in text:
                errors.append("rotated table text missing for " + str(block.get("id")))

    headings = [str(block.get("text") or "") for block in blocks if block.get("type") == "heading"]
    for order_group in expect.get("order") or []:
        positions = []
        for label in order_group:
            try:
                positions.append(next(index for index, heading in enumerate(headings) if heading == label))
            except StopIteration:
                errors.append("missing heading for order: " + label)
        if len(positions) == len(order_group) and positions != sorted(positions):
            errors.append("heading order wrong: " + json.dumps(order_group, ensure_ascii=False))

    audit_findings = structure_audit.get("findings") or []
    for item in audit_findings:
        errors.append(
            "structure audit: "
            + str(item.get("rule"))
            + " / "
            + str(item.get("message"))
            + " / "
            + json.dumps(item.get("evidence") or {}, ensure_ascii=False)
        )

    return {
        "id": case["id"],
        "source": str(pdf),
        "out": str(case_dir),
        "pages": pages,
        "blockTypes": counts,
        "references": len(references),
        "warnings": warnings,
        "structureAudit": {
            "path": str(audit_dir / "audit-report.json"),
            "ok": bool(structure_audit.get("ok")),
            "findings": len(audit_findings),
        },
        "errors": errors,
        "ok": not errors,
    }


def main() -> int:
    args = parse_args()
    cases = load_json(Path(args.cases))
    if args.case:
        wanted = set(args.case)
        cases = [case for case in cases if case.get("id") in wanted]
    sources = resolve_sources(cases, args)
    out_root = Path(args.out).resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    results = []
    for case in cases:
        result = run_case(case, sources[str(case["id"])], out_root)
        results.append(result)
        if not result["ok"] and not args.keep_going:
            break
    report = {
        "ok": all(item["ok"] for item in results) and len(results) == len(cases),
        "cases": results,
    }
    (out_root / "regression-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
