#!/usr/bin/env python3
"""Deterministic structure audit for a completed PDF MirrorDoc job.

The audit consumes only artifacts already produced by the extractor and
reconciler. It never rewrites MirrorDoc. Every finding carries a stable rule
id and source evidence so a later run can be compared mechanically.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import statistics
from collections import Counter
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


FINAL_METRICS_RE = re.compile(r"<!-- final-mirrordoc (?P<json>\{.*\}) -->")
PAGE_TOTAL_RE = re.compile(r"\b\d+\s+(?:of|/)\s+\d+\b", re.I)
STEP_RE = re.compile(r"^\s*(?P<number>\d{1,4})\s*[:.]\s*(?P<text>.+)$")
REF_NUMBER_RE = re.compile(r"^\s*\[?(?P<number>\d{1,4})[\].)]\s+")
END_CONNECTOR_RE = re.compile(
    r"(?:\b(?:and|or|but|nor|of|the|to|for|in|on|with|by|from|as|"
    r"that|which|while|where|when)\s*)$",
    re.I,
)
TRANSITION_START_RE = re.compile(
    r"^(?:Accordingly|Additionally|Moreover|However|Therefore|Thus|Hence|"
    r"Furthermore|Finally|Consequently|In this work|In the present study)\b",
    re.I,
)
STRUCTURAL_HEADING_RE = re.compile(
    r"^(?:Abstract|Keywords|References|Bibliography|Acknowledg(?:e)?ments?|"
    r"Author Contributions|Funding|Data Availability(?: Statement)?|"
    r"Conflicts? of Interest(?: Statement)?|Institutional Review Board Statement|"
    r"Informed Consent Statement|Abbreviations|Appendix(?:\s+[A-Z0-9]+)?|"
    r"(?:Text|Data|Table|Figure|Methods|Protocol|Movie|Audio|Video)\s+S\d+|"
    r"Supplementary(?:\s+Materials?)?)\s*:?\s*$",
    re.I,
)
ALL_CAPS_HEADING_RE = re.compile(r"^[A-Z][A-Z0-9 &/.\-]{2,}$")


def load_json(path: Path, default: Any = None) -> Any:
    if not path.is_file():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def normalized(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def fingerprint(text: Any) -> str:
    """Normalize page-varying running heads into one comparable signature."""
    value = normalized(text).lower()
    value = re.sub(r"\b\d+(?:[.,]\d+)*\b", "#", value)
    return re.sub(r"\s+", " ", value).strip(" .-|")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def percentile(values: List[int], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1))
    return float(ordered[index])


def source_text(lines: List[Dict[str, Any]], ids: Iterable[Any]) -> str:
    by_id = {str(line.get("id")): line for line in lines}
    return " ".join(normalized(by_id[str(source_id)].get("text")) for source_id in ids if str(source_id) in by_id)


def finding(
    rule: str,
    severity: str,
    message: str,
    **evidence: Any,
) -> Dict[str, Any]:
    return {
        "rule": rule,
        "severity": severity,
        "message": message,
        "evidence": {key: value for key, value in evidence.items() if value not in (None, "", [], {})},
    }


def detect_running_heads(lines: List[Dict[str, Any]], body_size: float) -> List[Dict[str, Any]]:
    candidates = [
        line
        for line in lines
        if int(line.get("page") or 0) > 1
        and float(line.get("top") or 0) < 90
        and len(normalized(line.get("text"))) <= 100
        and float(line.get("size") or 0) <= max(body_size * 1.02, 1.0)
        and line.get("role") != "caption"
    ]
    signatures = Counter(fingerprint(line.get("text")) for line in candidates if fingerprint(line.get("text")))
    evidence = []
    for line in candidates:
        text = normalized(line.get("text"))
        signature = fingerprint(text)
        if PAGE_TOTAL_RE.search(text) or signatures.get(signature, 0) >= 3:
            evidence.append(
                {
                    "sourceId": line.get("id"),
                    "page": line.get("page"),
                    "text": text[:180],
                    "signature": signature,
                    "signatureCount": signatures.get(signature, 0),
                }
            )
    return evidence


def detect_suspicious_headings(
    blocks: List[Dict[str, Any]],
    lines: List[Dict[str, Any]],
    running_ids: set[str],
) -> List[Dict[str, Any]]:
    by_id = {str(line.get("id")): line for line in lines}
    body_sizes = [
        float(line.get("size") or 0)
        for line in lines
        if 7 <= float(line.get("size") or 0) <= 12
        and len(normalized(line.get("text"))) >= 30
    ]
    body_size = statistics.median(body_sizes) if body_sizes else 10.0
    out: List[Dict[str, Any]] = []
    for block in blocks:
        if block.get("type") != "heading":
            continue
        text = normalized(block.get("text"))
        source_ids = [str(value) for value in block.get("sourceIds") or []]
        if not text:
            continue
        reasons: List[str] = []
        if re.fullmatch(r"(?:BEGIN|END(?:\s+(?:IF|WHILE))?)", text, re.I):
            reasons.append("algorithm-boundary-as-heading")
        if PAGE_TOTAL_RE.search(text) or any(source_id in running_ids for source_id in source_ids):
            reasons.append("running-head")
        if text.endswith((",", ";", ":")) or END_CONNECTOR_RE.search(text):
            reasons.append("unfinished-sentence")
        if TRANSITION_START_RE.search(text) and len(text.split()) >= 6:
            reasons.append("paragraph-transition")
        source = by_id.get(source_ids[0]) if source_ids else None
        inferred_from_single_line = len(source_ids) == 1
        source_size = float((source or {}).get("size") or 0)
        source_bold = bool((source or {}).get("bold"))
        numbered = bool(re.match(r"^\d+(?:\.\d+)*\.?\s+", text))
        structural = bool(STRUCTURAL_HEADING_RE.fullmatch(text))
        all_caps = bool(ALL_CAPS_HEADING_RE.fullmatch(text))
        if (
            inferred_from_single_line
            and not numbered
            and not structural
            and not all_caps
            and not source_bold
            and source_size < body_size * 1.08
        ):
            reasons.append("no-typographic-heading-signal")
        if reasons:
            out.append(
                finding(
                    "heading.false-positive",
                    "error" if "algorithm-boundary-as-heading" in reasons or "running-head" in reasons else "warning",
                    "heading 缺少可靠结构信号或属于正文/算法边界",
                    blockId=block.get("id"),
                    page=block.get("page"),
                    text=text[:220],
                    sourceIds=source_ids,
                    reasons=sorted(set(reasons)),
                )
            )
    return out


def detect_algorithm_issues(blocks: List[Dict[str, Any]], lines: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    by_id = {str(line.get("id")): line for line in lines}
    algorithms = [block for block in blocks if block.get("type") == "algorithm"]
    for block in blocks:
        text = normalized(block.get("text"))
        numbers = [int(value) for value in re.findall(r"(?:^|\s)(\d{1,4})\s*[:.]\s+", text)]
        starts_with_step_one = bool(re.match(r"^\s*1\s*[:.]\s+", text))
        sequential = any(
            numbers[index : index + 3] == [1, 2, 3]
            for index in range(max(0, len(numbers) - 2))
        )
        if block.get("type") == "paragraph" and starts_with_step_one and sequential:
            out.append(
                finding(
                    "algorithm.numbered-paragraph",
                    "error",
                    "编号步骤被压入普通 paragraph，行边界丢失",
                    blockId=block.get("id"),
                    page=block.get("page"),
                    steps=sorted(set(numbers)),
                    text=text[:260],
                )
            )
    for block in algorithms:
        steps = block.get("steps") or []
        if len(steps) < 2:
            out.append(
                finding(
                    "algorithm.incomplete",
                    "error",
                    "algorithm 块存在，但未保留逐步骤结构",
                    blockId=block.get("id"),
                    page=block.get("page"),
                    stepCount=len(steps),
                )
            )
        for step in steps:
            source = by_id.get(str(step.get("sourceId")))
            if source and normalized(step.get("text")) != normalized(source.get("text")):
                out.append(
                    finding(
                        "algorithm.step-mismatch",
                        "error",
                        "algorithm 步骤文字与源行不一致",
                        blockId=block.get("id"),
                        sourceId=step.get("sourceId"),
                        expected=normalized(source.get("text")),
                        actual=step.get("text"),
                    )
                )
        control_steps = [
            step
            for step in steps
            if re.match(
                r"^\s*\d+\s*[:.]\s*(?:WHILE|IF|ELSE\s+IF|END\s+(?:IF|WHILE))\b",
                normalized(step.get("text")),
                re.I,
            )
        ]
        if len(control_steps) >= 2 and all(int(step.get("depth") or 0) == 0 for step in steps):
            out.append(
                finding(
                    "algorithm.control-flow-flat",
                    "error",
                    "算法包含 WHILE/IF 控制流，但所有步骤深度均为 0",
                    blockId=block.get("id"),
                    page=block.get("page"),
                    controlSteps=[step.get("text") for step in control_steps],
                )
            )
    algorithm_captions = [
        block
        for block in blocks
        if block.get("type") in ("caption", "algorithm")
        and re.match(r"^Algorithm\s+\d+", normalized(block.get("caption") or block.get("text")), re.I)
    ]
    for caption in algorithm_captions:
        if caption.get("type") != "algorithm":
            out.append(
                finding(
                    "algorithm.caption-unattached",
                    "error",
                    "算法题注存在，但没有聚合成 algorithm 块",
                    blockId=caption.get("id"),
                    page=caption.get("page"),
                    text=normalized(caption.get("caption") or caption.get("text"))[:220],
                )
            )
    return out


def detect_unattached_captions(blocks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Surface captions whose visual asset was not recovered."""
    findings: List[Dict[str, Any]] = []
    assets = {
        "figure": {normalized(block.get("label")).lower() for block in blocks if block.get("type") == "figure"},
        "table": {normalized(block.get("label")).lower() for block in blocks if block.get("type") == "table"},
    }
    for block in blocks:
        if block.get("type") != "caption":
            continue
        text = normalized(block.get("text"))
        match = re.match(r"^(Fig(?:ure)?\.?|Table)\s+(\d+)\b", text, re.I)
        if not match:
            continue
        kind = "table" if match.group(1).lower() == "table" else "figure"
        label = f"{kind.title()} {match.group(2)}"
        if label.lower() in assets[kind]:
            continue
        findings.append(
            finding(
                f"{kind}.caption-unattached",
                "warning",
                f"{label} 有题注但没有对应视觉资产",
                blockId=block.get("id"),
                page=block.get("page"),
                text=text[:220],
            )
        )
    return findings


def detect_abstract_issues(
    lines: List[Dict[str, Any]],
    doc: Dict[str, Any],
    layout: Dict[str, Any],
) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    abstract_lines = [
        line
        for line in lines
        if int(line.get("page") or 0) == 1
        and re.fullmatch(r"Abstract\s*:?", normalized(line.get("text")), re.I)
    ]
    blocks = doc.get("blocks") or []
    abstract_blocks = [block for block in blocks if block.get("type") == "abstract"]
    abstract_chars = len(normalized((doc.get("meta") or {}).get("abstract")))
    if abstract_lines and not abstract_blocks:
        out.append(
            finding(
                "abstract.not-classified",
                "error",
                "源文存在独立 Abstract 标题，但终稿没有 abstract 块",
                sourceIds=[line.get("id") for line in abstract_lines],
                pages=[line.get("page") for line in abstract_lines],
            )
        )
    if abstract_lines and abstract_chars == 0:
        out.append(
            finding(
                "abstract.metadata-empty",
                "error",
                "源文存在 Abstract，但 meta.abstract 为空",
                sourceIds=[line.get("id") for line in abstract_lines],
            )
        )
    warnings = layout.get("warnings") or []
    if abstract_lines and any("关键信息缺失：abstract" in str(item) for item in warnings):
        out.append(
            finding(
                "abstract.stale-layout-warning",
                "error",
                "layout report 仍报告 abstract 缺失",
                warning=warnings,
            )
        )
    return out


def detect_reading_order(lines: List[Dict[str, Any]]) -> tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Find full-width text lines that still contain a two-column gutter."""
    findings: List[Dict[str, Any]] = []
    for line in lines:
        if line.get("role") not in ("prose", "heading"):
            continue
        if line.get("columnScope") != "full":
            continue
        text = normalized(line.get("text"))
        if len(text) < 40:
            continue
        page_width = float(line.get("pageWidth") or 595.0)
        x0 = float(line.get("x0") or 0)
        x1 = float(line.get("x1") or 0)
        gap = float(line.get("maxCenterGap") or 0)
        if x0 > page_width * 0.27 or x1 < page_width * 0.73 or gap < 18:
            continue
        findings.append(
            finding(
                "reading-order.cross-column-line",
                "error",
                "全宽文本行仍跨越双栏栏缝，左右栏内容被拼成一个视觉行",
                sourceId=line.get("id"),
                page=line.get("page"),
                bbox=[
                    round(float(line.get("x0") or 0), 2),
                    round(float(line.get("top") or 0), 2),
                    round(float(line.get("x1") or 0), 2),
                    round(float(line.get("bottom") or 0), 2),
                ],
                maxCenterGap=gap,
                text=text[:260],
            )
        )
    return findings, {
        "fullWidthLines": sum(1 for line in lines if line.get("columnScope") == "full"),
        "crossColumnLines": len(findings),
        "pages": sorted(
            {
                int(item["evidence"]["page"])
                for item in findings
                if item.get("evidence", {}).get("page") is not None
            }
        ),
    }


def detect_separators(
    blocks: List[Dict[str, Any]],
    rules: List[Dict[str, Any]],
) -> tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Check that detected content rules entered a block or visual-rule slot."""
    represented = {
        str(block.get("ruleId"))
        for block in blocks
        if block.get("type") == "separator" and block.get("ruleId")
    }
    for block in blocks:
        for rule in block.get("visualRules") or []:
            if rule.get("ruleId"):
                represented.add(str(rule["ruleId"]))
    findings = []
    for rule in rules:
        if str(rule.get("id") or "") in represented:
            continue
        findings.append(
            finding(
                "separator.unrepresented",
                "error",
                "检测到正文/特殊块分隔线，但 MirrorDoc 没有对应结构",
                ruleId=rule.get("id"),
                page=rule.get("page"),
                bbox=[rule.get("x0"), rule.get("top"), rule.get("x1"), rule.get("bottom")],
                aboveRole=rule.get("aboveRole"),
                belowRole=rule.get("belowRole"),
                aboveText=rule.get("aboveText"),
                belowText=rule.get("belowText"),
            )
        )
    return findings, {
        "detected": len(rules),
        "represented": len(rules) - len(findings),
        "unrepresented": len(findings),
        "pages": sorted({int(rule.get("page") or 0) for rule in rules}),
    }


def detect_coverage_and_freshness(
    job: Path,
    lines: List[Dict[str, Any]],
    blocks: List[Dict[str, Any]],
    layout: Dict[str, Any],
) -> tuple[List[Dict[str, Any]], Dict[str, Any]]:
    findings: List[Dict[str, Any]] = []
    source_ids = [str(line.get("id")) for line in lines]
    duplicate_source_ids = sorted(value for value, count in Counter(source_ids).items() if count > 1)
    assigned: List[str] = []
    unknown_refs: List[Dict[str, Any]] = []
    known = set(source_ids)
    by_id = {str(line.get("id")): line for line in lines}
    for block in blocks:
        for source_id in block.get("sourceIds") or []:
            value = str(source_id)
            assigned.append(value)
            if value not in known:
                unknown_refs.append({"blockId": block.get("id"), "sourceId": value})
    captions_by_page: Dict[int, List[str]] = {}
    for block in blocks:
        if block.get("type") in ("table", "figure", "caption"):
            captions_by_page.setdefault(int(block.get("page") or 0), []).append(
                normalized(block.get("caption") or block.get("text")).lower()
            )
    content_ids: set[str] = set()
    ignored_noise: List[Dict[str, Any]] = []
    assigned_set = set(assigned)
    for line in lines:
        text = normalized(line.get("text"))
        if line.get("role") in ("furniture", "meta"):
            continue
        if str(line.get("id")) in assigned_set:
            content_ids.add(str(line.get("id")))
            continue
        stripped = re.sub(r"^[.\s·•…]+", "", text).strip()
        caption_duplicate = (
            stripped
            and len(stripped) <= 60
            and any(
                stripped.lower() in caption
                for caption in captions_by_page.get(int(line.get("page") or 0), [])
            )
        )
        if (
            re.fullmatch(r"[.·•…\s]+", text)
            or re.fullmatch(r"doi:\S+", text, re.I)
            or caption_duplicate
        ):
            ignored_noise.append(
                {
                    "sourceId": line.get("id"),
                    "page": line.get("page"),
                    "role": line.get("role"),
                    "text": text[:160],
                    "reason": "caption-duplicate" if caption_duplicate else "asset/metadata-noise",
                }
            )
            continue
        content_ids.add(str(line.get("id")))
    missing_content = sorted(content_ids - set(assigned))
    leaked_furniture = sorted(
        {
            source_id
            for source_id in assigned
            if source_id in by_id and by_id[source_id].get("role") in ("furniture", "meta")
        }
    )
    if duplicate_source_ids:
        findings.append(
            finding(
                "coverage.duplicate-source-id",
                "error",
                "lines.json 存在重复 sourceId",
                sourceIds=duplicate_source_ids[:30],
            )
        )
    if unknown_refs:
        findings.append(
            finding(
                "coverage.unknown-source-id",
                "error",
                "MirrorDoc 引用了 lines.json 中不存在的 sourceId",
                references=unknown_refs[:30],
            )
        )
    if missing_content:
        findings.append(
            finding(
                "coverage.missing-content",
                "error",
                "有内容行没有进入任何 MirrorDoc block",
                sourceIds=missing_content[:50],
            )
        )
    if leaked_furniture:
        findings.append(
            finding(
                "coverage.furniture-leak",
                "error",
                "furniture/meta 源行进入正文",
                sourceIds=leaked_furniture[:50],
                previews=[
                    {
                        "sourceId": source_id,
                        "role": by_id[source_id].get("role"),
                        "text": normalized(by_id[source_id].get("text"))[:180],
                    }
                    for source_id in leaked_furniture[:12]
                ],
            )
        )

    final_counts = Counter(str(block.get("type") or "unknown") for block in blocks)
    report_path = job / "report.md"
    report_text = report_path.read_text(encoding="utf-8") if report_path.is_file() else ""
    match = FINAL_METRICS_RE.search(report_text)
    final_metrics = None
    if not match:
        findings.append(
            finding(
                "report.final-metrics-missing",
                "warning",
                "report.md 没有二次复核后的最终指标，可能仍展示提取阶段旧数据",
            )
        )
    else:
        try:
            final_metrics = json.loads(match.group("json"))
            if int(final_metrics.get("blocks") or -1) != len(blocks):
                findings.append(
                    finding(
                        "report.final-metrics-stale",
                        "error",
                        "report.md 的最终 block 数与 MirrorDoc 不一致",
                        reported=final_metrics.get("blocks"),
                        actual=len(blocks),
                    )
                )
            if int(final_metrics.get("paragraphs") or -1) != final_counts.get("paragraph", 0):
                findings.append(
                    finding(
                        "report.final-paragraphs-stale",
                        "error",
                        "report.md 的最终 paragraph 数与 MirrorDoc 不一致",
                        reported=final_metrics.get("paragraphs"),
                        actual=final_counts.get("paragraph", 0),
                    )
                )
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            findings.append(
                finding(
                    "report.final-metrics-invalid",
                    "error",
                    "report.md 的最终指标标记无法解析",
                    error=str(error),
                )
            )
    stats = {
        "sourceLines": len(lines),
        "sourceIdsAssigned": len(set(assigned)),
        "contentLines": len(content_ids),
        "missingContentLines": len(missing_content),
        "ignoredNoiseLines": len(ignored_noise),
        "ignoredNoise": ignored_noise[:30],
        "furnitureLeakSourceIds": leaked_furniture,
        "finalMetrics": final_metrics,
        "layoutKeyInfo": layout.get("keyInfo"),
    }
    return findings, stats


def detect_paragraph_issues(
    blocks: List[Dict[str, Any]],
    lines: List[Dict[str, Any]],
) -> tuple[List[Dict[str, Any]], Dict[str, Any]]:
    findings: List[Dict[str, Any]] = []
    paragraphs = [block for block in blocks if block.get("type") == "paragraph"]
    lengths = [len(normalized(block.get("text"))) for block in paragraphs]
    for index, block in enumerate(blocks[:-1]):
        if block.get("type") != "paragraph" or blocks[index + 1].get("type") != "paragraph":
            continue
        previous = normalized(block.get("text"))
        following = blocks[index + 1]
        next_text = normalized(following.get("text"))
        same_section = (block.get("section") or "") == (following.get("section") or "")
        if (
            same_section
            and previous
            and next_text
            and not re.search(r'[.!?][\"\'”’)]?$', previous)
            and re.match(r"^[a-z0-9(]", next_text)
        ):
            findings.append(
                finding(
                    "paragraph.suspicious-split",
                    "warning",
                    "相邻同节段落呈现句中断裂，可能是跨栏/跨页续段未合并",
                    blockId=block.get("id"),
                    nextBlockId=following.get("id"),
                    page=block.get("page"),
                    previous=previous[-160:],
                    next=next_text[:160],
                    sourceIds=list(block.get("sourceIds") or []) + list(following.get("sourceIds") or []),
                )
            )

    by_id = {str(line.get("id")): line for line in lines}
    complete_terms: set[str] = set()
    for line in lines:
        text = normalized(line.get("text"))
        trailing = re.search(r"([A-Za-z]+)-$", text)
        for match in re.finditer(r"(?<![A-Za-z])([A-Za-z]+(?:-[A-Za-z]+)*)(?![A-Za-z])", text):
            token = match.group(1).lower()
            if trailing and token == trailing.group(1).lower() and match.end() == len(text) - 1:
                continue
            complete_terms.add(token)
    hyphen_candidates = []
    for index, line in enumerate(lines[:-1]):
        text = normalized(line.get("text"))
        following = lines[index + 1]
        if (
            text.endswith("-")
            and int(following.get("page") or 0) == int(line.get("page") or 0)
            and following.get("columnScope") == line.get("columnScope")
            and normalized(following.get("text"))[:1].islower()
        ):
            hyphen_candidates.append(
                {
                    "sourceId": line.get("id"),
                    "nextSourceId": following.get("id"),
                    "page": line.get("page"),
                    "left": text[-50:],
                    "right": normalized(following.get("text"))[:50],
                }
            )
    surviving = []
    collapsed_lexical = []
    block_by_source = {
        str(source_id): block
        for block in blocks
        for source_id in block.get("sourceIds") or []
    }
    for candidate in hyphen_candidates:
        left = normalized(by_id[candidate["sourceId"]].get("text"))
        right = normalized(by_id[candidate["nextSourceId"]].get("text"))
        stem = re.search(r"([A-Za-z]+)-$", left)
        prefix = re.match(r"([A-Za-z]+)", right)
        if not stem or not prefix:
            continue
        broken = stem.group(1) + "-" + prefix.group(1)
        joined = stem.group(1) + prefix.group(1)
        block = block_by_source.get(candidate["sourceId"]) or block_by_source.get(candidate["nextSourceId"])
        block_text = normalized((block or {}).get("text")).lower()
        broken_present = broken.lower() in block_text
        joined_present = bool(
            re.search(
                r"(?<![A-Za-z])" + re.escape(joined.lower()) + r"(?![A-Za-z])",
                block_text,
            )
        )
        if joined_present:
            continue
        if broken.lower() in complete_terms and joined.lower() not in complete_terms:
            if joined_present and not broken_present:
                collapsed_lexical.append({**candidate, "collapsedForm": joined})
            continue
        if joined.lower() in complete_terms and broken_present:
            surviving.append({**candidate, "brokenForm": broken})
    if surviving:
        findings.append(
            finding(
                "text.hyphenation-not-restored",
                "error",
                "源行末尾连字符没有被合并还原",
                candidates=surviving[:20],
            )
        )
    if collapsed_lexical:
        findings.append(
            finding(
                "text.lexical-hyphen-collapsed",
                "error",
                "原页中明确存在的复合词连字符被错误删除",
                candidates=collapsed_lexical[:20],
            )
        )
    stats = {
        "paragraphs": len(paragraphs),
        "medianChars": statistics.median(lengths) if lengths else 0,
        "p10Chars": percentile(lengths, 0.10),
        "p90Chars": percentile(lengths, 0.90),
        "shortUnder40": sum(value < 40 for value in lengths),
        "shortUnder80": sum(value < 80 for value in lengths),
        "hyphenCandidates": len(hyphen_candidates),
        "hyphenationSurvivors": len(surviving),
        "collapsedLexicalHyphens": len(collapsed_lexical),
    }
    return findings, stats


def detect_references(blocks: List[Dict[str, Any]]) -> tuple[List[Dict[str, Any]], Dict[str, Any]]:
    references = [block for block in blocks if block.get("type") == "reference"]
    numbers: List[int] = []
    for block in references:
        match = REF_NUMBER_RE.match(normalized(block.get("text")))
        if match:
            numbers.append(int(match.group("number")))
    counts = Counter(numbers)
    duplicates = sorted(number for number, count in counts.items() if count > 1)
    missing = list(range(1, max(numbers) + 1)) if numbers else []
    missing = [number for number in missing if number not in counts]
    findings = []
    if duplicates:
        findings.append(
            finding(
                "references.duplicate-number",
                "warning",
                "参考文献编号重复",
                numbers=duplicates,
                blockIds=[
                    block.get("id")
                    for block in references
                    if REF_NUMBER_RE.match(normalized(block.get("text")))
                    and int(REF_NUMBER_RE.match(normalized(block.get("text"))).group("number")) in duplicates
                ],
            )
        )
    if missing:
        findings.append(
            finding(
                "references.missing-number",
                "error",
                "参考文献编号不连续",
                numbers=missing,
            )
        )
    return findings, {
        "count": len(references),
        "numbered": len(numbers),
        "first": numbers[0] if numbers else None,
        "last": numbers[-1] if numbers else None,
        "duplicates": duplicates,
        "missing": missing,
    }


def detect_tables(
    blocks: List[Dict[str, Any]],
    lines: List[Dict[str, Any]],
    layout: Dict[str, Any],
) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    findings: List[Dict[str, Any]] = []
    by_id = {str(line.get("id")): line for line in lines}
    tables = [block for block in blocks if block.get("type") == "table"]
    summary = []
    for block in tables:
        source_ids = [str(value) for value in block.get("sourceIds") or []]
        body_ids = [
            source_id
            for source_id in source_ids
            if source_id in by_id and by_id[source_id].get("role") == "table_body"
        ]
        table_text = str(block.get("tableText") or "")
        explicit_newlines = table_text.count("\n")
        item = {
            "blockId": block.get("id"),
            "page": block.get("page"),
            "label": block.get("label"),
            "asset": bool(block.get("asset")),
            "sourceTableBodyLines": len(body_ids),
            "tableTextChars": len(normalized(table_text)),
            "explicitNewlines": explicit_newlines,
            "rotated": bool(block.get("rotatedPage")),
        }
        summary.append(item)
        if not block.get("asset"):
            findings.append(
                finding(
                    "table.asset-missing",
                    "error",
                    "表格块没有可显示的原表裁剪",
                    **item,
                )
            )
        if len(body_ids) >= 4 and explicit_newlines == 0:
            findings.append(
                finding(
                    "table.text-flattened",
                    "error",
                    "表格保留了大量源行，但 tableText 没有任何可视化行边界",
                    blockId=block.get("id"),
                    page=block.get("page"),
                    label=block.get("label"),
                    sourceTableBodyLines=len(body_ids),
                )
            )
        bbox = [float(value) for value in block.get("bbox") or []]
        if len(bbox) == 4:
            table_like_rows = []
            cursor_bottom = bbox[3]
            for line in sorted(
                (
                    line
                    for line in lines
                    if int(line.get("page") or 0) == int(block.get("page") or 0)
                    and line.get("role") not in ("table_body", "caption", "furniture", "meta")
                    and bbox[0] <= (float(line.get("x0") or 0) + float(line.get("x1") or 0)) / 2 <= bbox[2]
                    and float(line.get("top") or 0) >= bbox[3]
                ),
                key=lambda line: float(line.get("top") or 0),
            ):
                top = float(line.get("top") or 0)
                text = normalized(line.get("text"))
                if (
                    text[:1].islower()
                    or len(text) > 140
                    or (text.endswith(".") and len(text.split()) > 10)
                ):
                    break
                table_like = bool(re.search(r"\b\d+(?:\.\d+)?\s*%", text)) or len(
                    re.findall(r"(?:^|\s)\d+(?:\.\d+)?(?:\s|$)", text)
                ) >= 2
                if top - cursor_bottom > 55 or not table_like:
                    break
                table_like_rows.append(
                    {
                        "sourceId": line.get("id"),
                        "role": line.get("role"),
                        "top": top,
                        "text": text[:180],
                    }
                )
                cursor_bottom = max(cursor_bottom, float(line.get("bottom") or top))
            item["tableLikeRowsOutsideCrop"] = len(table_like_rows)
            if table_like_rows:
                findings.append(
                    finding(
                        "table.crop-cuts-data-rows",
                        "error",
                        "表格裁剪边界之后仍有连续表格数据行，当前 crop 不完整",
                        blockId=block.get("id"),
                        page=block.get("page"),
                        label=block.get("label"),
                        bbox=bbox,
                        rows=table_like_rows[:30],
                    )
                )
    layout_tables = layout.get("tables") or []
    if layout_tables and len(layout_tables) != len(tables):
        findings.append(
            finding(
                "table.layout-count-mismatch",
                "error",
                "layout report 与 MirrorDoc 的表格数量不一致",
                layout=len(layout_tables),
                mirror=len(tables),
            )
        )
    for warning in layout.get("warnings") or []:
        if re.search(r"(?:Table|表格|裁剪)", str(warning), re.I):
            findings.append(finding("table.layout-warning", "warning", str(warning)))
    return findings, summary


def compare_reports(current: Dict[str, Any], baseline: Dict[str, Any]) -> Dict[str, Any]:
    def counts(report: Dict[str, Any]) -> Dict[str, int]:
        return Counter(item.get("rule") for item in report.get("findings") or [])

    before = counts(baseline)
    after = counts(current)
    rules = sorted(set(before) | set(after))
    return {
        "baselinePath": baseline.get("_path"),
        "resolvedRules": {
            rule: before[rule] - after[rule]
            for rule in rules
            if before[rule] > after[rule]
        },
        "newRules": {
            rule: after[rule] - before[rule]
            for rule in rules
            if after[rule] > before[rule]
        },
        "ruleCountsBefore": dict(sorted(before.items())),
        "ruleCountsAfter": dict(sorted(after.items())),
    }


def build_report(job: Path) -> Dict[str, Any]:
    lines = load_json(job / "lines.json", [])
    doc = load_json(job / "mirrordoc.json", {})
    layout = load_json(job / "layout-report.json", {})
    assets = load_json(job / "assets.json", [])
    rules = load_json(job / "rules.json", [])
    blocks = list(doc.get("blocks") or [])
    sizes = [
        float(line.get("size") or 0)
        for line in lines
        if 7 <= float(line.get("size") or 0) <= 12
        and len(normalized(line.get("text"))) >= 30
    ]
    body_size = statistics.median(sizes) if sizes else 10.0
    running = detect_running_heads(lines, body_size)
    running_ids = {str(item["sourceId"]) for item in running}

    findings: List[Dict[str, Any]] = []
    findings.extend(
        finding(
            "running-head.unclassified",
            "error",
            "页顶 running header 未被识别为 furniture",
            **item,
        )
        for item in running
        if item["sourceId"] not in {
            str(line.get("id"))
            for line in lines
            if line.get("role") == "furniture"
        }
    )
    coverage_findings, coverage = detect_coverage_and_freshness(job, lines, blocks, layout)
    paragraph_findings, paragraphs = detect_paragraph_issues(blocks, lines)
    reference_findings, references = detect_references(blocks)
    table_findings, tables = detect_tables(blocks, lines, layout)
    reading_order_findings, reading_order = detect_reading_order(lines)
    separator_findings, separators = detect_separators(blocks, rules)
    findings.extend(coverage_findings)
    findings.extend(detect_suspicious_headings(blocks, lines, running_ids))
    findings.extend(detect_algorithm_issues(blocks, lines))
    findings.extend(detect_unattached_captions(blocks))
    findings.extend(detect_abstract_issues(lines, doc, layout))
    findings.extend(paragraph_findings)
    findings.extend(reference_findings)
    findings.extend(table_findings)
    findings.extend(reading_order_findings)
    findings.extend(separator_findings)

    severity_counts = Counter(item["severity"] for item in findings)
    by_type = Counter(str(block.get("type") or "unknown") for block in blocks)
    report = {
        "version": 1,
        "job": str(job.resolve()),
        "fingerprint": {
            "mirrordocSha256": sha256_file(job / "mirrordoc.json") if (job / "mirrordoc.json").is_file() else "",
            "linesSha256": sha256_file(job / "lines.json") if (job / "lines.json").is_file() else "",
        },
        "meta": doc.get("meta") or {},
        "counts": {
            "pages": int((doc.get("meta") or {}).get("pageCount") or 0),
            "blocks": len(blocks),
            "blockTypes": dict(sorted(by_type.items())),
            "assets": len(assets),
            "findings": len(findings),
            "severity": dict(sorted(severity_counts.items())),
        },
        "coverage": coverage,
        "readingOrder": reading_order,
        "separators": separators,
        "paragraphs": paragraphs,
        "references": references,
        "tables": tables,
        "layoutWarnings": layout.get("warnings") or [],
        "findings": findings,
        "scopeLimits": [
            "deterministic structure only; Chinese translation semantics are not scored",
            "table crops are checked by row continuity and source coverage, not cell-level visual truth",
            "content rules are scored only after isolated body-rule detection; table/vector borders use asset coverage",
            "no external model verdict is used; ok=true means this audit scope passed",
        ],
        "ok": not any(item["severity"] == "error" for item in findings),
    }
    return report


def write_markdown(path: Path, report: Dict[str, Any]) -> None:
    counts = report["counts"]
    lines = [
        "# PDF Structure Audit",
        "",
        f"- Job: `{report['job']}`",
        f"- Title: {report['meta'].get('title') or ''}",
        f"- Pages: {counts['pages']}",
        f"- Blocks: {counts['blocks']}",
        f"- Block types: `{json.dumps(counts['blockTypes'], ensure_ascii=False)}`",
        f"- Findings: {counts['findings']} `{json.dumps(counts['severity'], ensure_ascii=False)}`",
        f"- Result: {'PASS' if report['ok'] else 'FAIL'}",
        "",
        "## Scope limits",
        "",
        *[f"- {item}" for item in report.get("scopeLimits") or []],
        "",
        "## Metrics",
        "",
        "```json",
        json.dumps(
            {
                "coverage": report["coverage"],
                "readingOrder": report["readingOrder"],
                "separators": report["separators"],
                "paragraphs": report["paragraphs"],
                "references": report["references"],
                "tables": report["tables"],
            },
            ensure_ascii=False,
            indent=2,
        ),
        "```",
        "",
        "## Findings",
        "",
    ]
    if report["findings"]:
        for index, item in enumerate(report["findings"], start=1):
            lines.append(
                f"### {index}. [{item['severity']}] `{item['rule']}` {item['message']}"
            )
            lines.append("")
            lines.append("```json")
            lines.append(json.dumps(item["evidence"], ensure_ascii=False, indent=2))
            lines.append("```")
            lines.append("")
    else:
        lines.append("- None")
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job", type=Path, help="job directory containing lines/mirrordoc")
    parser.add_argument("--out", type=Path, help="audit output directory")
    parser.add_argument("--baseline", type=Path, help="previous audit-report.json")
    parser.add_argument(
        "--fail-on",
        choices=("error", "warning", "never"),
        default="error",
        help="exit status threshold (default: error)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    job = args.job.resolve()
    for required in ("lines.json", "mirrordoc.json"):
        if not (job / required).is_file():
            print(f"missing {required}: {job / required}")
            return 2
    report = build_report(job)
    if args.baseline:
        baseline = load_json(args.baseline, {})
        baseline["_path"] = str(args.baseline.resolve())
        report["comparison"] = compare_reports(report, baseline)
    out = (args.out or job / "structure-audit").resolve()
    out.mkdir(parents=True, exist_ok=True)
    (out / "audit-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    write_markdown(out / "audit-report.md", report)
    print(
        json.dumps(
            {
                "out": str(out),
                "ok": report["ok"],
                "counts": report["counts"],
                "comparison": report.get("comparison"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    if args.fail_on == "never":
        return 0
    if args.fail_on == "warning":
        return 0 if not report["findings"] else 1
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
