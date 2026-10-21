#!/usr/bin/env python3
"""Second-pass layout reconciliation for a PDF job.

The first pass extracts text and crops visual assets. This pass checks the
result against the original page images and fixes presentation-only issues:

  - strip reconstruction dots from table/figure captions;
  - split a flattened SUPPORTING INFORMATION tail into headings/items;
  - mark code-like paragraphs as code;
  - verify every table has a non-empty crop with a matching aspect ratio;
  - write a side-by-side visual audit sheet.

It is intentionally conservative: it never invents missing text.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List

from PIL import Image, ImageChops, ImageDraw, ImageStat


LEADING_DOTS_RE = re.compile(r"^[\s.·•…]+")
SUPPORTING_RE = re.compile(r"\bSUPPORTING\s+INFORMATION\b", re.I)
SUPPORT_ITEM_RE = re.compile(r"((?:Text|Data|Table|Figure|Methods|Protocol|Appendix|Movie|Audio|Video)\s+S\d+)\b", re.I)
CODE_HINT_RE = re.compile(r"(?:library\s*\(|<-|\bfunction\s*\(|\bsummary\s*\(|\bsetwd\s*\(|^\s*>\s*)", re.M)
REFERENCES_HEAD_RE = re.compile(r"^\s*(?:REFERENCES?|BIBLIOGRAPHY)\s*$", re.I)
ACK_HEAD_RE = re.compile(r"^\s*ACKNOWLEDGE?MENTS?\s*$", re.I)
SUPPORT_HEAD_RE = re.compile(r"^\s*SUPPORTING\s+INFORMATION\s*$", re.I)
SUPPORT_ITEM_HEAD_RE = re.compile(
    r"^\s*((?:Text|Data|Table|Figure|Methods|Protocol|Appendix|Movie|Audio|Video)\s+S\d+)\s*$",
    re.I,
)
REF_NUMBER_RE = re.compile(r"^\s*\[?(\d{1,4})[\].)]\s+")
MULTI_SPACE_RE = re.compile(r"[ \t\u00a0]+")
MATH_LIMIT_RE = re.compile(r"^[A-Za-z0-9\s∈∑√,;:+\-−=<>≤≥\[\](){}|.!_'′″]+$")
CID_REPLACEMENTS = {
    "(cid:48)(cid:48)": "″",
    "(cid:48)": "′",
}


def normalize_text(value: Any, keep_newlines: bool = False) -> str:
    """Normalize inserted text without changing its words.

    PDF line reconstruction can leave tabs, non-breaking spaces and stray
    blank lines. HTML collapses most of them, but code blocks and mixed
    renderers do not. Normalizing once at ingestion keeps paragraph starts,
    line spacing and copy/paste output consistent.
    """
    text = str(value or "").replace("\ufeff", "").replace("\u00ad", "")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    for src, dst in CID_REPLACEMENTS.items():
        text = text.replace(src, dst)
    if keep_newlines:
        lines = [MULTI_SPACE_RE.sub(" ", line).strip() for line in text.split("\n")]
        text = "\n".join(lines)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip("\n").strip()
    return MULTI_SPACE_RE.sub(" ", text.replace("\n", " ")).strip()


def clean_caption(value: str) -> str:
    text = LEADING_DOTS_RE.sub("", str(value or "")).strip()
    return re.sub(r"[ .·•…]{4,}$", "", text).strip()


def split_supporting(blocks: List[Dict[str, Any]]) -> tuple[List[Dict[str, Any]], int]:
    """Split a flattened Supporting Information tail into readable blocks."""
    out: List[Dict[str, Any]] = []
    splits = 0
    in_supporting = False

    def emit_items(block: Dict[str, Any], text: str):
        preamble = ""
        first = SUPPORT_ITEM_RE.search(text)
        if first and first.start() > 0:
            preamble = text[: first.start()].strip()
        if preamble:
            out.append({**block, "type": "paragraph", "text": preamble})
        parts = re.split(r"(?=(?:Text|Data|Table|Figure)\s+S\d+\b)", text, flags=re.I)
        for part in parts:
            part = part.strip()
            if not part:
                continue
            item = SUPPORT_ITEM_RE.match(part)
            if item:
                label = re.sub(r"\s+", " ", item.group(1))
                rest = part[item.end() :].strip()
                out.append({
                    **block,
                    "type": "heading",
                    "level": 4,
                    "text": label,
                    "section": "SUPPORTING INFORMATION",
                })
                if rest:
                    out.append({**block, "type": "paragraph", "text": rest})
            else:
                out.append({**block, "type": "paragraph", "text": part})

    for block in blocks:
        text = str(block.get("text") or "")
        if block.get("type") == "paragraph":
            item = SUPPORT_ITEM_RE.match(text)
            if item:
                label = re.sub(r"\s+", " ", item.group(1))
                rest = text[item.end() :].strip()
                out.append({
                    **block,
                    "type": "heading",
                    "level": 4,
                    "text": label,
                    "section": "SUPPORTING INFORMATION",
                })
                if rest:
                    out.append({**block, "type": "paragraph", "text": rest})
                splits += 1
                continue
        if block.get("type") == "heading" and SUPPORTING_RE.search(text):
            out.append(block)
            in_supporting = True
            splits += 1
            continue
        if in_supporting and block.get("type") in ("heading", "reference"):
            in_supporting = False
            out.append(block)
            continue
        if in_supporting and block.get("type") == "paragraph" and SUPPORT_ITEM_RE.search(text):
            emit_items(block, text)
            continue
        match = SUPPORTING_RE.search(text)
        if not match:
            out.append(block)
            continue
        before = text[: match.start()].strip()
        after = text[match.end() :].strip()
        if before:
            out.append({**block, "type": "paragraph", "text": before})
        out.append({
            **block,
            "type": "heading",
            "level": 3,
            "text": "SUPPORTING INFORMATION",
            "section": "SUPPORTING INFORMATION",
        })
        splits += 1
        in_supporting = True
        emit_items(block, after)
    return out, splits


def split_reference_data_items(blocks: List[Dict[str, Any]]) -> tuple[List[Dict[str, Any]], int]:
    """Pull Data S1 / Table S1 tails out of a reference entry."""
    out: List[Dict[str, Any]] = []
    splits = 0
    for block in blocks:
        text = str(block.get("text") or "")
        if block.get("type") != "reference":
            out.append(block)
            continue
        match = re.search(r"\b(Data|Table|Figure)\s+S\d+\b", text, re.I)
        if not match:
            out.append(block)
            continue
        before = text[: match.start()].strip()
        after = text[match.start() :].strip()
        if before:
            out.append({**block, "text": before})
        item = SUPPORT_ITEM_RE.match(after)
        if not item:
            out.append({**block, "type": "paragraph", "text": after})
            continue
        label = re.sub(r"\s+", " ", item.group(1))
        rest = after[item.end() :].strip()
        out.append({
            **block,
            "type": "heading",
            "level": 4,
            "text": label,
            "section": "SUPPORTING INFORMATION",
            "column": "right",
        })
        if rest:
            out.append({**block, "type": "paragraph", "text": rest, "column": "right"})
        splits += 1
    return out, splits


def attach_support_continuations(blocks: List[Dict[str, Any]]) -> int:
    """Move a right-column ``Found at: ...sNNN`` line back to its Text Sn item."""
    support_paragraphs: Dict[str, Dict[str, Any]] = {}
    current_label = ""
    for block in blocks:
        if block.get("type") == "heading" and re.fullmatch(r"Text S\d+", str(block.get("text") or ""), re.I):
            current_label = str(block["text"])
            continue
        if current_label and block.get("type") == "paragraph":
            support_paragraphs[current_label] = block
            current_label = ""
    moved = 0
    for block in blocks:
        if block.get("type") != "reference":
            continue
        text = str(block.get("text") or "")
        match = re.search(r"Found at:\s*doi:\S+\.s(\d{3})\b.*$", text, re.I)
        if not match:
            continue
        label = f"Text S{int(match.group(1))}"
        target = support_paragraphs.get(label)
        if not target:
            continue
        target["text"] = (str(target.get("text") or "") + " " + match.group(0)).strip()
        block["text"] = text[: match.start()].strip()
        moved += 1
    return moved


def split_runin_headings(blocks: List[Dict[str, Any]], lines: List[Dict[str, Any]]) -> int:
    """Recover section headings that were glued to the following paragraph.

    In several layouts the heading line uses a larger font but the same
    column position as body text, so the line-based grouper keeps it inside
    the first paragraph (``Author Contributions Conceived ...``). The source
    line size is a deterministic signal; no visual inspection is needed.
    """
    by_id = {str(line.get("id")): line for line in lines}
    out: List[Dict[str, Any]] = []
    splits = 0
    for block_index, block in enumerate(blocks):
        if block.get("type") != "paragraph":
            out.append(block)
            continue
        source_ids = [str(value) for value in block.get("sourceIds") or []]
        if not source_ids:
            out.append(block)
            continue
        first = by_id.get(source_ids[0])
        if not first:
            out.append(block)
            continue
        first_text = normalize_text(first.get("text"))
        first_size = float(first.get("size") or 0)
        text = normalize_text(block.get("text"))
        second = by_id.get(source_ids[1]) if len(source_ids) > 1 else None
        if second is None and block_index + 1 < len(blocks):
            following_ids = blocks[block_index + 1].get("sourceIds") or []
            second = by_id.get(str(following_ids[0])) if following_ids else None
        second_size = float((second or {}).get("size") or 0)
        glued = len(source_ids) > 1
        starts_with_heading = text.startswith(first_text) if glued else text == first_text
        if (
            not first_text
            or len(first_text) > 90
            or len(first_text.split()) > 12
            or first_text[-1:] in ".:;!?"
            or not re.match(r"^[A-Z][A-Za-z0-9 ,&/–-]{2,}$", first_text)
            or second_size <= 0
            or first_size < second_size * 1.12
            or not starts_with_heading
        ):
            out.append(block)
            continue
        rest = text[len(first_text) :].strip() if glued else ""
        if len(rest) < 20:
            if len(source_ids) > 1:
                out.append(block)
                continue
        out.append({
            **block,
            "type": "heading",
            "level": int(block.get("level") or 3),
            "text": first_text,
            "section": first_text,
            "bbox": [first.get("x0", 0), first.get("top", 0), first.get("x1", 0), first.get("bottom", 0)],
            "sourceIds": [source_ids[0]],
        })
        if rest:
            out.append({
                **block,
                "type": "paragraph",
                "text": rest,
                "sourceIds": source_ids[1:],
            })
        splits += 1
    return out, splits


def merge_continuations(blocks: List[Dict[str, Any]]) -> int:
    """Join paragraph fragments split by a page or column boundary.

    A wrapped fragment is recognisable without images: the previous block
    does not end a sentence and the next one starts with a lowercase letter.
    This removes the fake paragraph gap in the middle of a sentence.
    """
    merged = 0
    out: List[Dict[str, Any]] = []
    index = 0
    while index < len(blocks):
        block = blocks[index]
        if block.get("type") == "paragraph":
            lookahead = index + 1
            while lookahead < len(blocks) and blocks[lookahead].get("type") in (
                "caption",
                "figure",
                "table",
                "equation",
            ):
                lookahead += 1
            if lookahead < len(blocks) and lookahead - index <= 2:
                candidate = blocks[lookahead]
                previous_text = normalize_text(block.get("text"))
                next_text = normalize_text(candidate.get("text"))
                if (
                    candidate.get("type") == "paragraph"
                    and (
                        candidate.get("section") == block.get("section")
                        or not candidate.get("section")
                        or not block.get("section")
                    )
                    and previous_text
                    and next_text
                    and not re.search(r"[.!?][\"'”’)]?$", previous_text)
                    and re.match(r"^[a-z0-9(]", next_text)
                ):
                    separator = "" if previous_text.endswith("-") else " "
                    block["text"] = previous_text + separator + next_text
                    block["sourceIds"] = list(block.get("sourceIds") or []) + list(candidate.get("sourceIds") or [])
                    if block.get("bbox") and candidate.get("bbox"):
                        left = min(float(block["bbox"][0]), float(candidate["bbox"][0]))
                        top = min(float(block["bbox"][1]), float(candidate["bbox"][1]))
                        right = max(float(block["bbox"][2]), float(candidate["bbox"][2]))
                        bottom = max(float(block["bbox"][3]), float(candidate["bbox"][3]))
                        block["bbox"] = [left, top, right, bottom]
                    merged += 1
                    out.append(block)
                    out.extend(blocks[index + 1 : lookahead])
                    index = lookahead + 1
                    continue
        if block.get("type") == "caption" and index + 1 < len(blocks):
            candidate = blocks[index + 1]
            previous_text = normalize_text(block.get("text") or block.get("caption"))
            next_text = normalize_text(candidate.get("text")) if candidate.get("type") == "paragraph" else ""
            if (
                next_text
                and not re.search(r"[.!?][\"'”’)]?$", previous_text)
                and re.match(r"^[a-z0-9(]", next_text)
            ):
                block["caption"] = (str(block.get("caption") or "") + " " + next_text).strip()
                block["text"] = (str(block.get("text") or "") + " " + next_text).strip()
                block["sourceIds"] = list(block.get("sourceIds") or []) + list(candidate.get("sourceIds") or [])
                merged += 1
                out.append(block)
                index += 2
                continue
        out.append(block)
        index += 1
    return out, merged


def _reference_number(text: Any) -> int:
    match = REF_NUMBER_RE.match(str(text or ""))
    return int(match.group(1)) if match else 0


def _support_kind_rank(label: str) -> tuple[int, int]:
    match = re.match(r"(Text|Figure|Table|Data)\s+S(\d+)", label, re.I)
    if not match:
        return (9, 0)
    order = {"text": 0, "figure": 1, "table": 2, "data": 3}
    return (order.get(match.group(1).lower(), 9), int(match.group(2)))


def order_logical_sections(blocks: List[Dict[str, Any]]) -> tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Put back matter in reading order, independent of physical columns.

    Two-column papers often place ACKNOWLEDGMENTS and the first half of the
    reference list in different columns. Physical column order is still the
    right default for body text, but references and back matter are logical
    sections: all numbered references belong together, then the back matter.
    """
    ref_heading = next(
        (
            block
            for block in blocks
            if block.get("type") == "heading" and REFERENCES_HEAD_RE.match(str(block.get("text") or ""))
        ),
        None,
    )
    if ref_heading is None:
        return blocks, {"applied": False, "reason": "no references heading"}

    numbered: List[tuple[int, Dict[str, Any]]] = []
    unnumbered: List[Dict[str, Any]] = []
    for block in blocks:
        if block.get("type") != "reference":
            continue
        number = _reference_number(block.get("text"))
        if number:
            numbered.append((number, block))
        else:
            unnumbered.append(block)
    numbered.sort(key=lambda item: item[0])
    references = [block for _, block in numbered] + unnumbered
    numbers = [number for number, _ in numbered]
    duplicates = sorted({number for number in numbers if numbers.count(number) > 1})
    missing = [number for number in range(1, (max(numbers) if numbers else 0) + 1) if number not in numbers]

    # Supporting Information: keep the section heading and each item's
    # heading + explanatory paragraph together, then order Text/Data items.
    support_items: List[tuple[tuple[int, int], List[Dict[str, Any]]]] = []
    index = 0
    while index < len(blocks):
        block = blocks[index]
        label = str(block.get("text") or "") if block.get("type") == "heading" else ""
        if not SUPPORT_ITEM_HEAD_RE.match(label):
            index += 1
            continue
        group = [block]
        cursor = index + 1
        while cursor < len(blocks):
            candidate = blocks[cursor]
            if candidate.get("type") in ("heading", "reference", "table", "figure", "equation"):
                break
            group.append(candidate)
            cursor += 1
        support_items.append((_support_kind_rank(label), group))
        index = cursor
    support_items.sort(key=lambda item: item[0])

    support_heading = next(
        (
            block
            for block in blocks
            if block.get("type") == "heading" and SUPPORT_HEAD_RE.match(str(block.get("text") or ""))
        ),
        None,
    )
    support_group: List[Dict[str, Any]] = []
    if support_heading or support_items:
        support_group.append(support_heading or {
            "type": "heading",
            "level": 1,
            "text": "SUPPORTING INFORMATION",
            "section": "SUPPORTING INFORMATION",
            "page": (
                int(support_items[0][1][0].get("page") or 0)
                if support_items
                else int(ref_heading.get("page") or 0)
            ),
            "sourceIds": [],
        })
        for _, group in support_items:
            support_group.extend(group)

    # Back matter after references: ACKNOWLEDGMENTS and its author
    # contributions, stopping before the next logical section.
    back_matter: List[Dict[str, Any]] = []
    ack_index = next(
        (
            i
            for i, block in enumerate(blocks)
            if block.get("type") == "heading" and ACK_HEAD_RE.match(str(block.get("text") or ""))
        ),
        None,
    )
    if ack_index is not None:
        cursor = ack_index
        while cursor < len(blocks):
            block = blocks[cursor]
            if cursor > ack_index and block.get("type") == "reference":
                break
            if (
                cursor > ack_index
                and block.get("type") == "heading"
                and (REFERENCES_HEAD_RE.match(str(block.get("text") or "")) or SUPPORT_HEAD_RE.match(str(block.get("text") or "")))
            ):
                break
            back_matter.append(block)
            cursor += 1

    consumed = set()
    for block in references + support_group + back_matter:
        consumed.add(id(block))
    for block in blocks:
        if block.get("type") == "heading" and (
            REFERENCES_HEAD_RE.match(str(block.get("text") or "")) or SUPPORT_HEAD_RE.match(str(block.get("text") or ""))
        ):
            consumed.add(id(block))
    body = [block for block in blocks if id(block) not in consumed]
    # Drop stale section labels: back matter and references are now explicit.
    for block in references:
        block["section"] = "REFERENCES"
    for block in support_group:
        block["section"] = "SUPPORTING INFORMATION"
    for block in back_matter:
        block["section"] = "ACKNOWLEDGMENTS"
    ref_heading["section"] = "REFERENCES"

    ordered = body + support_group + [ref_heading] + references + back_matter
    audit = {
        "applied": True,
        "references": len(references),
        "numbered": len(numbered),
        "first": numbers[0] if numbers else None,
        "last": numbers[-1] if numbers else None,
        "missing": missing,
        "duplicates": duplicates,
        "supportItems": [label for _, group in support_items for label in [str(group[0].get("text") or "")]],
        "backMatter": [str(block.get("text") or "")[:80] for block in back_matter],
    }
    return ordered, audit


def text_quality_issues(blocks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Flag text that looks like rotated/interleaved glyph soup.

    Automated layout checks are deliberately not allowed to silently bless
    gibberish. This pass is conservative: it flags likely broken blocks so a
    human/visual pass can inspect them, and translation skips them.
    """
    issues: List[Dict[str, Any]] = []
    for block in blocks:
        if block.get("type") not in ("paragraph", "heading", "caption", "code"):
            continue
        text = normalize_text(block.get("text"))
        if len(text) < 30:
            continue
        reasons = []
        if "\ufffd" in text or "(cid:" in text:
            reasons.append("replacement-glyph")
        if "⟦C" in text:
            reasons.append("unrestored-citation-token")
        tokens = text.split()
        if len(tokens) >= 8:
            singles = sum(1 for token in tokens if len(token.strip(".,;:()[]")) == 1)
            if singles / len(tokens) > 0.32:
                reasons.append("single-letter-interleave")
        if re.search(r"(?:[A-Za-z]\d){2,}", text):
            reasons.append("digit-letter-interleave")
        if re.search(r"(?:[A-Za-z]\s){8,}", text):
            reasons.append("spaced-letter-run")
        if reasons:
            block["qualityWarning"] = reasons
            issues.append({
                "blockId": block.get("id"),
                "page": block.get("page"),
                "reasons": reasons,
                "preview": text[:120],
            })
    return issues


def merge_equation_limits(blocks: List[Dict[str, Any]]) -> tuple[List[Dict[str, Any]], int]:
    """Attach a standalone math-domain line to the preceding equation.

    Some PDFs place ``t∈[t1,t2]`` on a separate text line below ``max ... (2)``.
    It classifies as prose, but translating it as a paragraph is wrong. Keep
    the original equation image and fold the short math-only line back into
    the equation block's text/source ids.
    """
    out: List[Dict[str, Any]] = []
    merged = 0
    for block in blocks:
        text = normalize_text(block.get("text"))
        previous = out[-1] if out else None
        is_limit = (
            block.get("type") == "paragraph"
            and len(text) <= 48
            and MATH_LIMIT_RE.fullmatch(text)
            and any(mark in text for mark in "∈∑√≤≥")
        )
        if (
            is_limit
            and previous
            and previous.get("type") == "equation"
            and previous.get("page") == block.get("page")
            and (previous.get("section") or "") == (block.get("section") or "")
        ):
            previous["text"] = normalize_text(str(previous.get("text") or "") + " " + text)
            previous["sourceIds"] = list(previous.get("sourceIds") or []) + list(block.get("sourceIds") or [])
            merged += 1
            continue
        out.append(block)
    return out, merged


def mark_code(blocks: List[Dict[str, Any]]) -> int:
    """Mark paragraphs that are predominantly R/code lines."""
    marked = 0
    for block in blocks:
        if block.get("type") != "paragraph":
            continue
        text = str(block.get("text") or "")
        if len(text) < 40:
            continue
        hits = len(CODE_HINT_RE.findall(text))
        if hits >= 2 or (hits >= 1 and text.count(";") >= 2):
            block["type"] = "code"
            block["language"] = "R"
            marked += 1
    return marked


def cleanup_noise(blocks: List[Dict[str, Any]]) -> tuple[List[Dict[str, Any]], int]:
    """Drop table-border dots, empty blocks, and duplicate caption rows."""
    repeated = Counter(
        str(block.get("text") or "").strip()
        for block in blocks
        if block.get("type") == "paragraph" and 0 < len(str(block.get("text") or "").strip()) <= 60
    )
    running_heads = {text for text, count in repeated.items() if count >= 2}
    captions = {
        (block.get("page"), clean_caption(block.get("caption", "")))
        for block in blocks
        if block.get("type") in ("table", "figure") and block.get("caption")
    }
    out = []
    removed = 0
    for block in blocks:
        text = str(block.get("text") or "").strip()
        if block.get("type") in ("paragraph", "caption", "heading", "code"):
            text = LEADING_DOTS_RE.sub("", text).strip()
            block["text"] = text
        if not text:
            removed += 1
            continue
        if block.get("type") == "paragraph" and re.match(
            r"^(?:Academic Editor:|Received\s+\w+\s+\d+,|Copyright:|Funding:|"
            r"Competing Interests:|\*\s*To whom correspondence)",
            text,
        ):
            # Journal metadata in the first-page sidebar is not article prose.
            removed += 1
            continue
        if (
            block.get("type") == "paragraph"
            and int(block.get("page") or 0) > 1
            and text in running_heads
        ):
            removed += 1
            continue
        if re.fullmatch(r"[.\s·•…]+", text):
            removed += 1
            continue
        normalized = LEADING_DOTS_RE.sub("", text).strip(" .·•…")
        if re.fullmatch(r"doi:\S+\.(?:t|g|s)\d+", normalized, re.I):
            removed += 1
            continue
        if block.get("type") == "caption":
            key = (block.get("page"), clean_caption(text))
            if key in captions:
                removed += 1
                continue
        out.append(block)
    merged = []
    i = 0
    while i < len(out):
        block = out[i]
        merged.append(block)
        if block.get("type") in ("table", "figure"):
            # A short caption tail can sit a few blocks later when a table
            # spans columns and its footnote/right-column text is emitted
            # between the table and the tail.
            for lookahead in range(i + 1, min(i + 4, len(out))):
                candidate = out[lookahead]
                if candidate.get("type") != "paragraph" or candidate.get("page") != block.get("page"):
                    continue
                continuation = clean_caption(candidate.get("text", ""))
                core = re.sub(r"[.\s·•…]", "", continuation)
                current = re.sub(r"[.\s·•…]", "", str(block.get("caption") or ""))
                if core and len(core) <= 30 and core.lower() not in current.lower():
                    block["caption"] = (str(block.get("caption") or "") + " " + continuation).strip()
                    out.pop(lookahead)
                    removed += 1
                    break
        i += 1
    return merged, removed


def page_scale(lines: List[Dict[str, Any]], page: int, image: Image.Image) -> tuple[float, float]:
    first = next((line for line in lines if int(line.get("page", 0)) == page), None)
    width = float(first.get("pageWidth", 595.0)) if first else 595.0
    height = float(first.get("pageHeight", 842.0)) if first else 842.0
    return image.width / width, image.height / height


def order_blocks_by_column(blocks: List[Dict[str, Any]], lines: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Keep full-width objects at the top/bottom and read columns left→right."""
    by_id = {str(line.get("id")): line for line in lines}
    table_pages = {
        int(block.get("page") or 0)
        for block in blocks
        if block.get("type") == "table"
    }
    for block in blocks:
        if block.get("column") in ("left", "right", "full"):
            continue
        if (
            block.get("type") == "paragraph"
            and int(block.get("page") or 0) in table_pages
            and re.match(r"^(?:The coefficient|The values|Note[:.]|Notes[:.])", str(block.get("text") or ""), re.I)
        ):
            # Table footnotes are full-width even when their first text line
            # starts in the left column; keep them with the table at the tail.
            block["column"] = "full"
            continue
        source = by_id.get(str((block.get("sourceIds") or [""])[0]))
        column = "full"
        if block.get("type") in ("table", "figure", "caption") and block.get("bbox"):
            bbox = [float(value) for value in block["bbox"]]
            page_width = float(source.get("pageWidth", 612.0)) if source else 612.0
            if bbox[2] - bbox[0] > page_width * 0.6:
                column = "full"
            else:
                column = "right" if (bbox[0] + bbox[2]) / 2 > page_width / 2 else "left"
        elif block.get("type") not in ("title", "abstract") and source:
            column = source.get("columnScope", "full")
        block["column"] = column

    pages: Dict[int, List[Dict[str, Any]]] = {}
    for block in blocks:
        pages.setdefault(int(block.get("page") or 0), []).append(block)
    ordered: List[Dict[str, Any]] = []
    for page in sorted(pages):
        page_blocks = pages[page]
        left = [block for block in page_blocks if block.get("column") == "left"]
        right = [block for block in page_blocks if block.get("column") == "right"]
        full = [block for block in page_blocks if block.get("column") not in ("left", "right")]
        if not left or not right:
            ordered.extend(sorted(page_blocks, key=lambda block: float((block.get("bbox") or [0, 0, 0, 0])[1])))
            continue
        left_top = min(float((block.get("bbox") or [0, 0, 0, 0])[1]) for block in left)
        right_top = min(float((block.get("bbox") or [0, 0, 0, 0])[1]) for block in right)
        column_top = min(left_top, right_top)
        column_bottom = max(
            float((block.get("bbox") or [0, 0, 0, 0])[3]) for block in left + right
        )
        head = [
            block for block in full
            if float((block.get("bbox") or [0, 0, 0, 0])[1]) < column_top
        ]
        tail = [
            block for block in full
            if float((block.get("bbox") or [0, 0, 0, 0])[1]) > column_bottom
        ]
        middle = [block for block in full if block not in head and block not in tail]
        ordered.extend(sorted(head, key=lambda block: float((block.get("bbox") or [0, 0, 0, 0])[1])))
        ordered.extend(sorted(left, key=lambda block: float((block.get("bbox") or [0, 0, 0, 0])[1])))
        ordered.extend(sorted(right, key=lambda block: float((block.get("bbox") or [0, 0, 0, 0])[1])))
        ordered.extend(sorted(middle, key=lambda block: float((block.get("bbox") or [0, 0, 0, 0])[1])))
        ordered.extend(sorted(tail, key=lambda block: float((block.get("bbox") or [0, 0, 0, 0])[1])))
    return ordered


def visual_audit(job: Path, doc: Dict[str, Any], lines: List[Dict[str, Any]]) -> Dict[str, Any]:
    audit_dir = job / "audit"
    audit_dir.mkdir(exist_ok=True)
    tables = []
    warnings = []
    rows = []
    for block in doc.get("blocks", []):
        if block.get("type") != "table":
            continue
        label = block.get("label") or "Table"
        asset_rel = block.get("asset") or ""
        asset_path = job / asset_rel
        bbox = block.get("bbox") or []
        page = int(block.get("page") or 0)
        page_path = job / "source-pages" / f"page-{page:02d}.png"
        entry = {
            "label": label,
            "page": page,
            "bbox": bbox,
            "rotated": bool(block.get("rotatedPage")),
            "asset": asset_rel,
            "assetExists": asset_path.is_file(),
            "assetBytes": asset_path.stat().st_size if asset_path.is_file() else 0,
            "aspectDelta": None,
            "pixelMeanDiff": None,
            "blank": None,
        }
        if not asset_path.is_file():
            warnings.append(f"{label}: 缺少表格裁剪图")
        if page_path.is_file() and len(bbox) == 4 and asset_path.is_file():
            try:
                page_image = Image.open(page_path).convert("RGB")
                sx, sy = page_scale(lines, page, page_image)
                crop = page_image.crop(
                    (
                        max(0, int(float(bbox[0]) * sx)),
                        max(0, int(float(bbox[1]) * sy)),
                        min(page_image.width, int(float(bbox[2]) * sx)),
                        min(page_image.height, int(float(bbox[3]) * sy)),
                    )
                )
                source_crop = audit_dir / f"{label.lower().replace(' ', '-')}-source.png"
                crop.save(source_crop)
                asset_image = Image.open(asset_path).convert("RGB")
                entry["blank"] = ImageStat.Stat(asset_image).var[0] < 10
                bbox_ratio = (float(bbox[2]) - float(bbox[0])) / max(1.0, float(bbox[3]) - float(bbox[1]))
                if entry["rotated"]:
                    bbox_ratio = 1.0 / max(0.001, bbox_ratio)
                asset_ratio = asset_image.width / max(1, asset_image.height)
                entry["aspectDelta"] = round(abs(bbox_ratio - asset_ratio), 3)
                if entry["blank"]:
                    warnings.append(f"{label}: 裁剪图接近空白")
                if entry["aspectDelta"] > 0.18:
                    warnings.append(f"{label}: 裁剪图长宽比与 bbox 偏差 {entry['aspectDelta']}")
                if entry["rotated"]:
                    crop = crop.rotate(-90, expand=True, fillcolor="white")
                resized = crop.resize(asset_image.size)
                diff = ImageChops.difference(resized, asset_image)
                entry["pixelMeanDiff"] = round(sum(ImageStat.Stat(diff).mean) / 3, 2)
                if entry["pixelMeanDiff"] > 55:
                    warnings.append(f"{label}: 裁剪图与原页区域差异较大（{entry['pixelMeanDiff']}）")
                rows.append((label, crop, asset_image))
            except Exception as error:
                warnings.append(f"{label}: 视觉复核失败（{error}）")
        tables.append(entry)

    if rows:
        thumb_w, thumb_h = 360, 150
        sheet = Image.new("RGB", (thumb_w * 2 + 24, (thumb_h + 28) * len(rows) + 12), "white")
        draw = ImageDraw.Draw(sheet)
        for index, (label, source, asset) in enumerate(rows):
            y = 12 + index * (thumb_h + 28)
            draw.text((8, y), label + " · 原页裁剪", fill="black")
            draw.text((thumb_w + 16, y), label + " · 阅读器裁剪", fill="black")
            source.thumbnail((thumb_w, thumb_h))
            asset.thumbnail((thumb_w, thumb_h))
            sheet.paste(source, (8, y + 16))
            sheet.paste(asset, (thumb_w + 16, y + 16))
        sheet.save(audit_dir / "layout-audit.png")

    report = {"tables": tables, "warnings": warnings, "visualAudit": "audit/layout-audit.png"}
    (job / "layout-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("job", type=Path)
    parser.add_argument("--progress", action="store_true")
    args = parser.parse_args()

    def progress(message: str):
        if args.progress:
            print("DPR_PROGRESS " + json.dumps({"stage": "verify", "message": message}, ensure_ascii=False), file=sys.stderr, flush=True)

    job = args.job
    doc_path = job / "mirrordoc.json"
    lines_path = job / "lines.json"
    doc = json.loads(doc_path.read_text(encoding="utf-8"))
    lines = json.loads(lines_path.read_text(encoding="utf-8"))
    blocks = doc.get("blocks", [])

    progress("复核表格与 Supporting Information…")
    metadata_removed = sum(
        1
        for block in blocks
        if block.get("type") == "paragraph"
        and re.match(
            r"^(?:Academic Editor:|Received\s+\w+\s+\d+,|Copyright:|Funding:|"
            r"Competing Interests:|\*\s*To whom correspondence)",
            str(block.get("text") or "").strip(),
        )
    )
    for block in blocks:
        if block.get("type") in ("table", "figure"):
            if block.get("caption"):
                block["caption"] = normalize_text(clean_caption(block["caption"]))
            if block.get("text"):
                block["text"] = normalize_text(LEADING_DOTS_RE.sub("", str(block["text"])))
    blocks, noise_removed = cleanup_noise(blocks)
    for block in blocks:
        if block.get("type") == "code":
            block["text"] = normalize_text(block.get("text"), keep_newlines=True)
        elif block.get("type") in ("paragraph", "heading", "reference", "caption"):
            block["text"] = normalize_text(block.get("text"))
    blocks, runin_headings = split_runin_headings(blocks, lines)
    blocks, supporting_splits = split_supporting(blocks)
    blocks, data_items = split_reference_data_items(blocks)
    support_continuations = attach_support_continuations(blocks)
    code_blocks = mark_code(blocks)
    blocks, equation_limits = merge_equation_limits(blocks)
    blocks = order_blocks_by_column(blocks, lines)
    continuations_merged = 0
    for _ in range(6):
        blocks, merged_this_pass = merge_continuations(blocks)
        continuations_merged += merged_this_pass
        if merged_this_pass == 0:
            break
    blocks, order_audit = order_logical_sections(blocks)
    text_issues = text_quality_issues(blocks)
    order_map = [
        normalize_text(block.get("text"))
        for block in blocks
        if block.get("type") == "heading"
    ]
    order_audit["orderMap"] = order_map
    for index, block in enumerate(blocks):
        block["id"] = f"b{index:04d}"
    doc["blocks"] = blocks
    doc["outline"] = [
        {"id": block["id"], "level": int(block.get("level", 1)), "title": block.get("text", ""), "blockId": block["id"]}
        for block in blocks
        if block.get("type") == "heading"
    ]
    audit = visual_audit(job, doc, lines)
    key_info = {
        "title": doc.get("meta", {}).get("title", ""),
        "authors": doc.get("meta", {}).get("authors", ""),
        "doi": doc.get("meta", {}).get("doi", ""),
        "abstractChars": len(doc.get("meta", {}).get("abstract", "") or ""),
        "headings": len([block for block in blocks if block.get("type") == "heading"]),
        "paragraphs": len([block for block in blocks if block.get("type") == "paragraph"]),
    }
    for field in ("title", "authors", "doi"):
        if not key_info[field]:
            audit["warnings"].append(f"关键信息缺失：{field}")
    if key_info["abstractChars"] == 0:
        audit["warnings"].append("关键信息缺失：abstract（可能原文没有摘要或未识别）")
    audit["keyInfo"] = key_info
    audit["rotatedTablePages"] = doc.get("coverage", {}).get("rotatedTablePages", [])
    audit["supportingInfoSplits"] = supporting_splits
    audit["referenceDataItems"] = data_items
    audit["supportContinuations"] = support_continuations
    audit["runinHeadings"] = runin_headings
    audit["equationLimitsMerged"] = equation_limits
    audit["continuationsMerged"] = continuations_merged
    audit["order"] = order_audit
    audit["orderMap"] = order_map
    audit["textQuality"] = text_issues
    if order_audit.get("missing"):
        audit["warnings"].append("参考文献编号缺失：" + json.dumps(order_audit["missing"]))
    if order_audit.get("duplicates"):
        audit["warnings"].append("参考文献编号重复：" + json.dumps(order_audit["duplicates"]))
    for issue in text_issues:
        audit["warnings"].append(
            f"文本疑似乱码：{issue['blockId']}（p.{issue['page']}）{','.join(issue['reasons'])}"
        )
    audit["codeBlocks"] = code_blocks
    audit["noiseRemoved"] = noise_removed
    audit["metadataRemoved"] = metadata_removed
    doc["layoutAudit"] = {
        "tables": len(audit["tables"]),
        "warnings": audit["warnings"],
        "supportingInfoSplits": supporting_splits,
        "referenceDataItems": data_items,
        "supportContinuations": support_continuations,
        "runinHeadings": runin_headings,
        "equationLimitsMerged": equation_limits,
        "continuationsMerged": continuations_merged,
        "order": order_audit,
        "textQuality": text_issues,
        "orderMap": order_map,
        "codeBlocks": code_blocks,
        "noiseRemoved": noise_removed,
        "metadataRemoved": metadata_removed,
        "keyInfo": key_info,
        "rotatedTablePages": doc.get("coverage", {}).get("rotatedTablePages", []),
        "visualAudit": audit["visualAudit"],
    }
    doc_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    (job / "layout-report.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
    report_path = job / "report.md"
    if report_path.exists():
        report_path.write_text(
            report_path.read_text(encoding="utf-8")
            + "\n## 二次格式复核\n"
            + f"- tables: {len(audit['tables'])}\n"
            + f"- supporting splits: {supporting_splits}\n"
            + f"- code blocks: {code_blocks}\n"
            + f"- run-in headings recovered: {runin_headings}\n"
            + f"- equation limits merged: {equation_limits}\n"
            + f"- paragraph continuations merged: {continuations_merged}\n"
            + f"- logical references: {order_audit.get('first')}–{order_audit.get('last')} ({order_audit.get('numbered')} numbered)\n"
            + f"- text quality warnings: {len(text_issues)}\n"
            + f"- warnings: {json.dumps(audit['warnings'], ensure_ascii=False)}\n"
            + f"- visual audit: {audit['visualAudit']}\n",
            encoding="utf-8",
        )
    progress(f"复核完成：{len(audit['tables'])} 个表，{supporting_splits} 个 Supporting 分块")
    print(json.dumps({"job": str(job), "tables": len(audit["tables"]), "warnings": audit["warnings"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
