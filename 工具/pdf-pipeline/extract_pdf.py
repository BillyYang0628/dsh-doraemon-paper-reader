#!/usr/bin/env python3
"""PDF -> MirrorDoc prototype.

This is the first, deliberately narrow slice of the reader pipeline:

  PDF text layer + page geometry
      -> lines with position stamps
      -> classified blocks (title / heading / prose / caption / equation ...)
      -> figures, tables and equations cropped from their source page
      -> MirrorDoc JSON + a standalone HTML reader

It is not a production PDF parser. It is a measurement tool: it makes the
loss visible (unclassified blocks, text coverage, asset counts) so we can
decide whether the HTML-first reader is viable before building the plugin UI.

The sample PDF is intentionally not part of this repository. Pass any local
PDF path on the command line.

Dependencies (all permissive):
  pdfplumber (MIT), pypdfium2 (Apache-2.0), Pillow (MIT-CMU)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import statistics
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import pdfplumber
import pypdfium2 as pdfium
from PIL import Image


# ---------------------------------------------------------------------------
# Text reconstruction
# ---------------------------------------------------------------------------

LIGATURES = {
    "\ufb00": "ff",
    "\ufb01": "fi",
    "\ufb02": "fl",
    "\ufb03": "ffi",
    "\ufb04": "ffl",
    "\ufb05": "st",
    "\ufb06": "st",
}

# A few math-font CMaps omit a ToUnicode entry. In the Sensors sample the
# only prose occurrence is ``15(cid:48)(cid:48)`` (15 inches); map the known
# prime pair deterministically instead of feeding a pseudo-glyph to the LLM.
CID_REPLACEMENTS = {
    "(cid:48)(cid:48)": "″",
    "(cid:48)": "′",
}

CAPTION_RE = re.compile(
    # Some publishers prefix captions with reconstruction dots (`. . . Table 1.`).
    r"^[\s.·•…]*(?P<kind>Figure|Fig\.|Table|Algorithm)\s+(?P<num>\d+[a-zA-Z]?)"
    r"(?:(?:[.:])\s*(?P<rest>.*)|)$",
    re.I,
)
HEADING_RE = re.compile(r"^(?P<num>\d+(?:\.\d+)*)\.?\s+(?P<title>[A-Z][^\n]{0,140})$")
EQUATION_RE = re.compile(r"\((?P<num>\d+[a-zA-Z]?)\)\s*$")
REFERENCE_ENTRY_RE = re.compile(r"^(?:\[(?P<bracket>\d+)\]|(?P<plain>\d+)\.)\s+")
REFERENCE_LINK_ONLY_RE = re.compile(
    r"^\d+\.\s+\[(?:CrossRef|PubMed|PubMed Central|Google Scholar|CAS|"
    r"ADS|INSPEC|MathSciNet|Semantic Scholar)\]\s*$",
    re.I,
)
AUTHOR_BIO_RE = re.compile(
    r"^(?:19|20)\d{2}\.\s+(?:His|Her|Their)\s+research\s+interests\b",
    re.I,
)
DOI_RE = re.compile(r"10\.\d{4,9}/[-._;()/:A-Z0-9]+", re.I)
ARXIV_RE = re.compile(r"arXiv[:\s]*(\d{4}\.\d{4,5}(?:v\d+)?)", re.I)
MATH_LIMIT_RE = re.compile(r"^[A-Za-z0-9\s∈∑√,;:+\-−=<>≤≥\[\](){}|.!_'′″]+$")
PAGE_TOTAL_RE = re.compile(r"\b\d+\s+(?:of|/)\s+\d+\b", re.I)
ALGORITHM_BOUNDARY_RE = re.compile(r"^(?:BEGIN|END(?:\s+(?:IF|WHILE))?)$", re.I)
ALGORITHM_STEP_RE = re.compile(r"^\s*(?P<number>\d{1,4})\s*[:.]\s*(?P<text>.+)$")
ALGORITHM_CUE_RE = re.compile(
    r"^(?:INPUT|OUTPUT|REQUIRE|ENSURE|FROM|WHILE|IF|ELSE|FOR\s+(?:ALL|EACH)|FOREACH|"
    r"RETURN|EXIT|BREAK|CONTINUE|PROCEDURE|FUNCTION|ADD|REMOVE|UPDATE|SET|LET|"
    r"INITIALIZE|COMPUTE|CHOOSE|SELECT|CREATE|CALL|#)",
    re.I,
)


def clean_text(value: str) -> str:
    """Normalize PDF text without silently deleting visible characters."""
    value = value.replace("\u00ad", "")
    for src, dst in LIGATURES.items():
        value = value.replace(src, dst)
    for src, dst in CID_REPLACEMENTS.items():
        value = value.replace(src, dst)
    value = value.replace("\u00a0", " ")
    value = re.sub(r"[ \t\r\f\v]+", " ", value)
    value = re.sub(r" *\n *", " ", value)
    return value.strip()


def _dedupe_chars(chars: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Drop duplicate glyphs emitted for the same visual position.

    The sample PDF emits two identical ``ﬁ`` glyphs with exactly the same
    bbox (``deﬁﬁned``); without this guard the ligature expansion turns the
    word into ``defifined``.
    """
    seen = set()
    out: List[Dict[str, Any]] = []
    for char in chars:
        key = (
            char.get("text"),
            round(float(char.get("x0", 0)), 1),
            round(float(char.get("x1", 0)), 1),
            round(float(char.get("top", 0)), 1),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(char)
    return out


def reconstruct_line_text(chars: Iterable[Dict[str, Any]]) -> str:
    """Put spaces back into a line whose PDF text layer has none.

    Word gaps in the sample are about 1.7–2.5 pt; gaps inside a word are
    effectively zero. A threshold of ``max(1.0, 0.18 * size)`` separates the
    two without hard-coding a single font.
    """
    chars = _dedupe_chars(chars)
    out: List[str] = []
    previous = None
    for char in chars:
        text = char.get("text", "")
        if previous is not None and text and not text.isspace():
            prev_text = previous.get("text", "")
            if prev_text and not prev_text.isspace():
                gap = float(char.get("x0", 0)) - float(previous.get("x1", 0))
                size = max(float(char.get("size", 0)), float(previous.get("size", 0)))
                if gap > max(1.0, 0.18 * size):
                    out.append(" ")
        if not text.isspace():
            out.append(text)
        previous = char
    return clean_text("".join(out))


def _median(values: Iterable[float]) -> float:
    values = [float(value) for value in values if value is not None]
    return statistics.median(values) if values else 0.0


def _dominant(values: Iterable[str]) -> str:
    counts: Dict[str, int] = {}
    for value in values:
        if value:
            counts[value] = counts.get(value, 0) + 1
    if not counts:
        return ""
    return max(counts, key=counts.get)


def _union_bbox(boxes: Iterable[Tuple[float, float, float, float]]) -> List[float]:
    boxes = list(boxes)
    if not boxes:
        return [0.0, 0.0, 0.0, 0.0]
    return [
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    ]


def _expanded(box: Tuple[float, float, float, float], pad: float = 2.0) -> Tuple[float, float, float, float]:
    return (box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad)


def _overlaps(a: Tuple[float, float, float, float], b: Tuple[float, float, float, float]) -> bool:
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def progress(enabled: bool, stage: str, message: str) -> None:
    """Emit a machine-readable stage line for the DSH host job runner."""
    if not enabled:
        return
    print(
        "DPR_PROGRESS " + json.dumps({"stage": stage, "message": message}, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )


# ---------------------------------------------------------------------------
# Line extraction and classification
# ---------------------------------------------------------------------------


def _detect_column_split(page: pdfplumber.page.Page, region_top: float) -> Optional[float]:
    """Find a persistent vertical whitespace band, if the page has columns."""
    chars = [
        char
        for char in page.chars
        if float(char.get("top", 0)) >= region_top
        and float(char.get("top", 0)) < float(page.height) - 60
        and char.get("text", "").strip()
    ]
    if len(chars) < 200:
        return None
    width = int(math.ceil(float(page.width)))
    occupied = [False] * (width + 2)
    for char in chars:
        start = max(0, int(math.floor(float(char["x0"]))))
        end = min(width + 1, int(math.ceil(float(char["x1"]))))
        for x in range(start, end + 1):
            occupied[x] = True
    runs = []
    x = 60
    while x < width - 60:
        if occupied[x]:
            x += 1
            continue
        start = x
        while x < width - 60 and not occupied[x]:
            x += 1
        end = x
        # Some PLOS two-column layouts leave only a ~5 pt gutter.
        if end - start >= 4:
            runs.append((start, end))
    if not runs:
        return None
    # Pick the widest internal gap and require text on both sides.
    runs.sort(key=lambda item: item[1] - item[0], reverse=True)
    for start, end in runs:
        left = sum(1 for char in chars if float(char["x1"]) <= start)
        right = sum(1 for char in chars if float(char["x0"]) >= end)
        if left >= 50 and right >= 50:
            return (start + end) / 2
    return None


def _is_rotated_page(page: pdfplumber.page.Page) -> bool:
    """True when most visible glyphs are sideways (a full-page rotated table)."""
    text_chars = [char for char in page.chars if char.get("text", "").strip()]
    if not text_chars:
        return False
    sideways = sum(1 for char in text_chars if not char.get("upright", True))
    return sideways / len(text_chars) > 0.5


def _infer_column_split(page: pdfplumber.page.Page) -> Optional[float]:
    """Infer columns from word starts when a figure fills the whitespace band.

    PLOS pages often have a full-width figure/table whose text/images occupy
    the central gutter, so the occupancy-based detector cannot see a clean
    band. A two-column page still has many words starting near the left margin
    and many starting just right of the midpoint; use that instead of treating
    the page as one giant line.
    """
    try:
        words = page.extract_words()
    except Exception:
        return None
    if len(words) < 80:
        return None
    width = float(page.width)
    left = [word for word in words if float(word["x0"]) < width * 0.25]
    right = [
        word
        for word in words
        if float(word["x0"]) > width * 0.45 and float(word["x1"]) > width * 0.75
    ]
    if len(left) < 20 or len(right) < 20:
        return None
    if len(right) / max(1, len(words)) < 0.12:
        return None
    # Full-width reference pages also contain many words starting in the
    # right half, which used to look like a second column and split every
    # visual line in the middle. A real column has a visible run of line
    # starts near one shared gutter (PLOS ~315 on a 612pt page).
    mid_band = width * 0.07
    anchored_starts = Counter(
        round(float(word["x0"]), 1)
        for word in right
        if abs(float(word["x0"]) - width * 0.5) <= mid_band
    )
    if not anchored_starts:
        return None
    gutter_start, anchored_count = anchored_starts.most_common(1)[0]
    # A full-width reference page can have a few incidental mid-line word
    # starts, but a real right column has many starts on one shared gutter.
    if anchored_count < 4:
        return None
    anchored_y = sorted(
        float(word["top"])
        for word in right
        if round(float(word["x0"]), 1) == gutter_start
    )
    window = max(80.0, float(page.height) * 0.2)
    clustered = max(
        (
            sum(1 for y in anchored_y if start <= y <= start + window)
            for start in anchored_y
        ),
        default=0,
    )
    if clustered < 4:
        return None
    crossing = sum(
        1
        for word in words
        if float(word["x0"]) < gutter_start - 5 and float(word["x1"]) > gutter_start + 5
    )
    if crossing / max(1, len(words)) > 0.08:
        return None
    return float(gutter_start)


def _column_end_for_full_width_artifact(
    clusters: List[Dict[str, Any]],
    page_height: float,
    page_width: float,
    region_top: float,
) -> Optional[float]:
    """Stop column bucketing at a large figure that fills the lower page."""
    candidates = [
        float(cluster["top"]) - 8
        for cluster in clusters
        if float(cluster["bbox"][2]) - float(cluster["bbox"][0]) > page_width * 0.6
        and float(cluster["bottom"]) > page_height * 0.6
        and float(cluster["top"]) > region_top + 40
    ]
    return min(candidates) if candidates else None


def _group_chars_to_lines(
    chars: List[Dict[str, Any]],
    page_no: int,
    scope: str,
) -> List[Dict[str, Any]]:
    """Group characters into visual lines inside one column."""
    clusters: List[List[Dict[str, Any]]] = []
    for char in sorted(chars, key=lambda item: (float(item["top"]), float(item["x0"]))):
        center = (float(char["top"]) + float(char["bottom"])) / 2
        placed = False
        for cluster in reversed(clusters[-4:]):
            reference = cluster[-1]
            ref_center = (float(reference["top"]) + float(reference["bottom"])) / 2
            tolerance = max(1.8, 0.25 * max(float(reference.get("size", 0)), float(char.get("size", 0))))
            vertical_overlap = min(float(char["bottom"]), float(reference["bottom"])) - max(
                float(char["top"]), float(reference["top"])
            )
            if abs(center - ref_center) <= tolerance or vertical_overlap >= 0.5 * min(
                float(char["bottom"]) - float(char["top"]),
                float(reference["bottom"]) - float(reference["top"]),
            ):
                cluster.append(char)
                placed = True
                break
        if not placed:
            clusters.append([char])
    clusters.sort(key=lambda cluster: (min(float(item["top"]) for item in cluster), min(float(item["x0"]) for item in cluster)))
    if scope == "full":
        split_clusters: List[List[Dict[str, Any]]] = []
        for cluster in clusters:
            ordered = sorted(cluster, key=lambda item: float(item["x0"]))
            cuts = [
                index
                for index in range(1, len(ordered))
                if float(ordered[index]["x0"]) - float(ordered[index - 1]["x1"]) > 45.0
            ]
            heading_right_cut = None
            for index in range(1, len(ordered)):
                gap = float(ordered[index]["x0"]) - float(ordered[index - 1]["x1"])
                if gap <= 8.0:
                    continue
                right_candidate = reconstruct_line_text(ordered[index:])
                right_candidate_match = HEADING_RE.match(right_candidate)
                if (
                    right_candidate_match
                    and _looks_like_heading_title(right_candidate_match.group("title"))
                    and len(reconstruct_line_text(ordered[:index])) >= 12
                ):
                    heading_right_cut = index
                    break
            if heading_right_cut is not None:
                cuts.append(heading_right_cut)
            if cuts:
                cut = max(
                    cuts,
                    key=lambda index: float(ordered[index]["x0"]) - float(ordered[index - 1]["x1"]),
                )
                left = ordered[:cut]
                right = ordered[cut:]
                left_text = reconstruct_line_text(left)
                right_text = reconstruct_line_text(right)
                left_match = HEADING_RE.match(left_text)
                right_match = HEADING_RE.match(right_text)
                if (
                    left_match
                    and _looks_like_heading_title(left_match.group("title"))
                    and len(right_text) >= 12
                ) or (
                    right_match
                    and _looks_like_heading_title(right_match.group("title"))
                    and len(left_text) >= 12
                ):
                    split_clusters.extend([left, right])
                    continue
            split_clusters.append(cluster)
        clusters = split_clusters
    out = []
    for line_index, cluster in enumerate(clusters, start=1):
        cluster.sort(key=lambda item: float(item["x0"]))
        text = reconstruct_line_text(cluster)
        if not text:
            continue
        sizes = [float(char.get("size", 0)) for char in cluster if char.get("size")]
        fonts = [str(char.get("fontname", "")) for char in cluster]
        out.append(
            {
                "id": f"p{page_no:03d}-{scope[0]}{line_index:03d}",
                "page": page_no,
                "columnScope": scope,
                "text": text,
                "x0": min(float(char["x0"]) for char in cluster),
                "top": min(float(char["top"]) for char in cluster),
                "x1": max(float(char["x1"]) for char in cluster),
                "bottom": max(float(char["bottom"]) for char in cluster),
                "size": _median(sizes),
                "font": _dominant(fonts),
                "bold": any("Bold" in font or "bold" in font for font in fonts),
                "italic": any("Italic" in font or "Oblique" in font for font in fonts),
            }
        )
    return out


def extract_lines(
    pdf_path: Path, max_pages: Optional[int] = None
) -> Tuple[List[Dict[str, Any]], int, set[int]]:
    """Extract column-aware, visually grouped lines with position stamps."""
    lines: List[Dict[str, Any]] = []
    rotated_pages: set[int] = set()
    with pdfplumber.open(str(pdf_path)) as pdf:
        page_count = len(pdf.pages)
        for page_index, page in enumerate(pdf.pages):
            if max_pages is not None and page_index >= max_pages:
                break
            page_no = page_index + 1
            page_height = float(page.height)
            if _is_rotated_page(page):
                # A full-page rotated table: its glyphs are 90/270 degrees
                # from the page's reading direction. Rendering it as lines
                # would create plausible-looking gibberish that can pass
                # naive text checks. Preserve the whole page as a table
                # image instead; crop_assets rotates it upright.
                rotated_pages.add(page_no)
                continue
            region_top = 250.0 if page_no == 1 else 60.0
            split = _detect_column_split(page, region_top)
            # A full-width table/figure at the top can erase the persistent
            # whitespace band used to detect two columns. Retry below that
            # object; the upper part stays `full`, the body below is split.
            if split is None and page_no > 1:
                lower_split = _detect_column_split(page, 220.0)
                if lower_split is not None:
                    split = lower_split
                    region_top = 220.0
            if split is None and page_no == 1:
                # A full-width abstract/title block can hide the body columns
                # from the usual upper-page probe. Probe below the abstract.
                lower_split = _detect_column_split(page, 400.0)
                if lower_split is not None:
                    split = lower_split
                    region_top = 400.0
            if split is None and page_no > 1:
                inferred = _infer_column_split(page)
                if inferred is not None:
                    split = inferred
                    region_top = 45.0
            column_end = page_height
            if split is not None and page_no > 1:
                boundary = _column_end_for_full_width_artifact(
                    _image_clusters(page, page_height),
                    page_height,
                    float(page.width),
                    region_top,
                )
                if boundary is not None:
                    column_end = boundary
            buckets: Dict[str, List[Dict[str, Any]]] = {"full": []}
            if split is not None:
                buckets["left"] = []
                buckets["right"] = []
            for char in page.chars:
                if not char.get("text", "").strip():
                    continue
                top = float(char.get("top", 0))
                if top < region_top or split is None or top >= column_end:
                    scope = "full"
                else:
                    scope = "left" if (float(char["x0"]) + float(char["x1"])) / 2 < split else "right"
                buckets.setdefault(scope, []).append(char)
            for scope in ("full", "left", "right"):
                if scope not in buckets:
                    continue
                for line in _group_chars_to_lines(buckets[scope], page_no, scope):
                    line["page_height"] = page_height
                    line["pageWidth"] = float(page.width)
                    line["columnSplit"] = split
                    lines.append(line)
    # Page order then visual order. Full-width title lines come before columns;
    # the left column on page 1 is the citation/copyright sidebar and is
    # classified as metadata below.
    lines.sort(
        key=lambda line: (
            int(line["page"]),
            0 if line.get("columnScope") == "full" else 1,
            0 if line.get("columnScope") == "left" else 1,
            float(line["top"]),
            float(line["x0"]),
        )
    )
    return lines, page_count, rotated_pages


def estimate_body_size(lines: Iterable[Dict[str, Any]]) -> float:
    sizes = [
        float(line["size"])
        for line in lines
        if 7.0 <= float(line["size"]) <= 12.0 and len(line["text"]) >= 30
    ]
    return _median(sizes) or 9.0


def _furniture_signature(text: str) -> str:
    """Normalize page-varying running heads without assuming a journal name."""
    value = clean_text(text).lower()
    value = re.sub(r"\b\d+(?:[.,]\d+)*\b", "#", value)
    return re.sub(r"\s+", " ", value).strip(" .-|")


def _looks_like_heading_title(text: str) -> bool:
    value = clean_text(text)
    words = value.split()
    if not value or len(words) > 14:
        return False
    if value.endswith((",", ";", ":")):
        return False
    if re.search(r"\b(?:and|or|but|of|the|to|for|in|on|with|by|from|as)\s*$", value, re.I):
        return False
    if value.endswith("-"):
        return False
    if re.match(
        r"^(?:There\s+(?:are|is)|We\s+|This\s+|These\s+|It\s+|Additionally\b|"
        r"Moreover\b|However\b|Therefore\b|Thus\b|Hence\b|Furthermore\b|Finally\b|"
        r"Consequently\b|In\s+this\b)",
        value,
        re.I,
    ):
        return False
    return True


def classify_line(line: Dict[str, Any], body_size: float) -> str:
    text = line["text"]
    page = int(line["page"])
    top = float(line["top"])
    bottom = float(line["bottom"])
    page_height = float(line.get("page_height", 842.0))
    size = float(line["size"])

    # Repeated page furniture. Keep it in the inventory, but do not render it.
    # Do not blanket-classify the top of page 1 as furniture: many PLOS/PLOS-
    # style PDFs put the real title at y≈55. Only a small journal banner or a
    # known journal masthead is furniture.
    if page == 1 and top < 45:
        return "furniture"
    if page == 1 and top < 110 and re.match(
        r"^(?:Sensors|Journal|Proceedings|IEEE|ACM|PLoS|PLOS|Nature|Science|Elsevier)\b",
        text,
        re.I,
    ):
        return "furniture"
    if page > 1 and top < 85 and re.match(
        r"^(Sensors|Journal|Proceedings|IEEE|ACM|Nature|Science|Elsevier)\b",
        text,
        re.I,
    ):
        return "furniture"
    if bottom > page_height - 55 and re.match(r"^(?:\d+\s*(?:of\s*\d+)?|https?://)", text):
        return "furniture"
    if bottom > page_height - 55 and size <= 8.5:
        return "furniture"
    if re.match(r"^\d+\s+of\s+\d+$", text):
        return "furniture"
    if re.fullmatch(r"[.·•…\s]+", text):
        return "furniture"

    # On page 1, a *narrow* left sidebar is citation/copyright metadata. In a
    # normal two-column paper the left column is body text, not metadata.
    page_width = float(line.get("pageWidth", 595.0))
    column_split = line.get("columnSplit")
    if (
        page == 1
        and line.get("columnScope") == "left"
        and column_split is not None
        and float(column_split) < page_width * 0.35
    ):
        return "meta"
    if CAPTION_RE.match(text):
        return "caption"
    if page == 1 and size >= 15 and top < 220:
        return "title"
    if page == 1 and top < 260 and (
        "@" in text
        or "University" in text
        or "Department" in text
        or "School" in text
        or "Institute" in text
        or "Faculty" in text
        or "Correspondence" in text
        or re.search(r"\b(?:Received|Accepted|Published|Academic Editor)\b", text)
    ):
        return "meta"
    if re.fullmatch(r"Abstract\s*[:—–-]?", text, re.I) or re.match(r"^Abstract\s*[:—–-]", text, re.I):
        return "abstract"
    if (
        page == 1
        and 140 <= top <= 280
        and re.match(r"^(?:Background|Principal Findings|Conclusions?|Significance|Objective|Methods|Results)\.", text, re.I)
    ):
        return "abstract"
    if re.match(r"^(?:Keywords|Index Terms)\s*[:—–-]", text, re.I):
        return "keywords"
    if re.match(r"^(References|Bibliography)\s*$", text, re.I):
        return "references_heading"
    # Algorithm sentinels are structural content, never document headings.
    if ALGORITHM_BOUNDARY_RE.fullmatch(text):
        return "prose"
    if (
        len(text) <= 60
        and len(text.split()) <= 8
        and text.isupper()
        and re.fullmatch(r"[A-Z][A-Z0-9 &/.\-]{2,}", text)
        and size >= body_size * 0.95
        and not re.search(r"\b(?:and|or|but|nor|of|the|to|for|in|on|with|by|from|as)\s*$", text, re.I)
    ):
        return "heading"
    heading_match = HEADING_RE.match(text)
    if heading_match and len(text) <= 140 and (size >= body_size * 0.95 or line["bold"]):
        if _looks_like_heading_title(heading_match.group("title")):
            return "heading"
    if EQUATION_RE.search(text) and ("=" in text or "(cid:" in text):
        return "equation"
    if re.match(r"^\([a-zA-Z]\)(?:\s*\([a-zA-Z]\))*$", text):
        return "figure_label"
    return "prose"


def annotate_roles(lines: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    body_size = estimate_body_size(lines)
    for line in lines:
        line["role"] = classify_line(line, body_size)
    # A numbered heading can wrap before its final title words. Recover only
    # when every continuation is bold, shares the column and font size, and
    # the combined title becomes structurally complete.
    for index, line in enumerate(lines):
        if line.get("role") != "prose" or not line.get("bold"):
            continue
        first_match = HEADING_RE.match(clean_text(line["text"]))
        if not first_match:
            continue
        group = [line]
        title = first_match.group("title")
        cursor = index + 1
        while cursor < len(lines) and len(group) < 4:
            candidate = lines[cursor]
            gap = float(candidate["top"]) - float(group[-1]["bottom"])
            if (
                candidate["page"] != line["page"]
                or candidate.get("columnScope") != line.get("columnScope")
                or candidate.get("role") != "prose"
                or not candidate.get("bold")
                or abs(float(candidate["size"]) - float(line["size"])) > 1.0
                or gap > 2.2 * max(float(line["size"]), 1.0)
            ):
                break
            group.append(candidate)
            title = (title + " " + clean_text(candidate["text"])).strip()
            if _looks_like_heading_title(title):
                line["role"] = "heading"
                for continuation in group[1:]:
                    continuation["role"] = "heading_continuation"
                break
            cursor += 1
    # Journal names are not a reliable whitelist. Detect page-varying running
    # heads by their normalized repeated signature or an explicit "N of M"
    # marker near the top edge.
    running_candidates = [
        line
        for line in lines
        if int(line["page"]) > 1
        and float(line["top"]) < 90
        and len(clean_text(line["text"])) <= 100
        and float(line["size"]) <= body_size * 1.02
        and line["role"] not in ("title", "caption")
    ]
    signatures = Counter(_furniture_signature(line["text"]) for line in running_candidates)
    for line in running_candidates:
        text = clean_text(line["text"])
        signature = _furniture_signature(text)
        if PAGE_TOTAL_RE.search(text) or signatures.get(signature, 0) >= 3:
            line["role"] = "furniture"
    # Everything between the title and the abstract on page 1 is author /
    # affiliation metadata, even when it has no email address.
    first_page = [line for line in lines if line["page"] == 1]
    abstract_top = min(
        (float(line["top"]) for line in first_page if line["role"] == "abstract"),
        default=None,
    )
    title_bottom = max(
        (float(line["bottom"]) for line in first_page if line["role"] == "title"),
        default=0.0,
    )
    first_body_top = min(
        (
            float(line["top"])
            for line in first_page
            if line["role"] in ("prose", "heading", "abstract")
            and float(line["top"]) > title_bottom
            and float(line["size"]) >= body_size * 0.95
        ),
        default=None,
    )
    body_start = abstract_top if abstract_top is not None else first_body_top
    if body_start is not None:
        for line in first_page:
            if (
                line["role"] not in ("title", "furniture", "abstract")
                and title_bottom < float(line["top"]) < body_start
            ):
                line["role"] = "meta"
    # PLOS and similar layouts put a journal metadata block (editor, dates,
    # copyright, funding, competing interests, corresponding author) in the
    # lower right column. Mark the whole run, not just the first line, so
    # continuation lines cannot be folded into the last body paragraph.
    meta_start = next(
        (
            index
            for index, line in enumerate(lines)
            if line["page"] == 1
            and re.match(r"^(?:Academic Editor|Received\b|Copyright:|Funding:|Competing Interests:)", line["text"], re.I)
        ),
        None,
    )
    if meta_start is not None:
        meta_scope = lines[meta_start].get("columnScope")
        for line in lines[meta_start:]:
            if line["page"] != 1:
                break
            # MDPI-style first pages put journal metadata in a narrow left
            # sidebar while the abstract and body live in the right column.
            # Only the metadata line's own column is metadata.
            if meta_scope and line.get("columnScope") != meta_scope:
                continue
            line["role"] = "meta"
            if re.search(r"\*\s*To whom correspondence", line["text"], re.I):
                break
    # PLOS-style first pages often omit an explicit "Abstract" heading. Treat
    # prose above the Citation line and below the byline as abstract text.
    citation_start = next(
        (
            index
            for index, line in enumerate(first_page)
            if re.match(r"^Citation:", line["text"], re.I)
        ),
        None,
    )
    if citation_start is not None:
        for line in first_page[:citation_start]:
            if line["role"] == "prose" and float(line["top"]) > 220:
                line["role"] = "abstract"
    # Reference entries such as "24. Kun, G.; ..." look exactly like numbered
    # section headings. Once the References heading is reached, a numbered
    # entry is prose, not a section.
    reference_start = next(
        (index for index, line in enumerate(lines) if line["role"] == "references_heading"),
        None,
    )
    if reference_start is not None:
        for line in lines[reference_start + 1 :]:
            if REFERENCE_ENTRY_RE.match(line["text"]):
                line["role"] = "prose"
        biography_start = next(
            (
                index
                for index, line in enumerate(lines[reference_start + 1 :], start=reference_start + 1)
                if AUTHOR_BIO_RE.match(clean_text(line["text"]))
            ),
            None,
        )
        if biography_start is not None:
            for line in lines[biography_start:]:
                line["role"] = "meta"
    # Repeated running heads (e.g. "Sharing Data Citation Rate") are furniture,
    # not body paragraphs. Count normalized short lines near the top of pages.
    running = Counter(
        clean_text(line["text"]).lower()
        for line in lines
        if int(line["page"]) > 1
        and float(line["top"]) < 80
        and line["role"] not in ("furniture",)
        and len(clean_text(line["text"])) <= 60
    )
    for line in lines:
        normalized = clean_text(line["text"]).lower()
        if (
            int(line["page"]) > 1
            and float(line["top"]) < 80
            and running.get(normalized, 0) >= 2
        ):
            line["role"] = "furniture"
    # A formula can start on a line containing only a radical glyph
    # (``(cid:113)``) and continue on the next line with ``= ... (1)``.
    for index, line in enumerate(lines):
        if line["role"] != "equation" or index == 0:
            continue
        previous = lines[index - 1]
        if (
            previous["role"] == "prose"
            and previous["text"].strip().startswith("(cid:")
            and len(previous["text"].strip()) < 40
        ):
            previous["role"] = "equation"
    # A display equation often puts its domain/limit on the following visual
    # line (``t∈[t1,t2]``). That line classifies as prose by punctuation but
    # belongs to the equation crop, not to the next body paragraph.
    for index, line in enumerate(lines[:-1]):
        if line["role"] != "equation" or not EQUATION_RE.search(line["text"]):
            continue
        following = lines[index + 1]
        if following["page"] != line["page"] or following["role"] != "prose":
            continue
        if line.get("columnScope") and following.get("columnScope") != line.get("columnScope"):
            continue
        if float(following["top"]) - float(line["bottom"]) > 30:
            continue
        text = clean_text(following["text"])
        if len(text) <= 48 and MATH_LIMIT_RE.fullmatch(text) and any(mark in text for mark in "∈∑√≤≥"):
            following["role"] = "equation"
    return lines


# ---------------------------------------------------------------------------
# Asset detection (figures / tables / equations)
# ---------------------------------------------------------------------------


def _horizontal_rules(page: pdfplumber.page.Page) -> List[Dict[str, float]]:
    rules = []
    for line in page.lines:
        if abs(float(line["bottom"]) - float(line["top"])) <= 1.0:
            rules.append(
                {
                    "x0": float(line["x0"]),
                    "x1": float(line["x1"]),
                    "top": float(line["top"]),
                }
            )
    # Many publisher PDFs draw table borders as thin filled rectangles, not
    # `page.lines`; include those so Table 1/2/3 are cropped as one visual
    # object instead of being flattened into prose.
    for rect in page.rects:
        x0, x1 = float(rect["x0"]), float(rect["x1"])
        top, bottom = float(rect["top"]), float(rect["bottom"])
        if 0 <= bottom - top <= 2.5 and x1 - x0 >= 80:
            rules.append({"x0": x0, "x1": x1, "top": (top + bottom) / 2})
    return rules


def _cluster_rects(rects: List[Dict[str, float]], gap: float = 25.0) -> List[List[Dict[str, float]]]:
    """Group image boxes that belong to the same visual figure."""
    if not rects:
        return []
    rects = sorted(rects, key=lambda item: (item["top"], item["x0"]))
    clusters: List[List[Dict[str, float]]] = []
    for rect in rects:
        placed = False
        for cluster in clusters:
            last = cluster[-1]
            vertical_gap = rect["top"] - max(item["bottom"] for item in cluster)
            horizontal_overlap = not (rect["x1"] <= last["x0"] or last["x1"] <= rect["x0"])
            if vertical_gap <= gap and (horizontal_overlap or abs(rect["x0"] - last["x0"]) < 80):
                cluster.append(rect)
                placed = True
                break
        if not placed:
            clusters.append([rect])
    return clusters


def _image_clusters(page: pdfplumber.page.Page, page_height: float) -> List[Dict[str, Any]]:
    rects = []
    for image in page.images:
        x0 = float(image["x0"])
        top = float(image["top"])
        x1 = float(image["x1"])
        bottom = float(image["bottom"])
        if top < 80 or bottom > page_height - 45:
            continue
        if (x1 - x0) * (bottom - top) < 3000:
            continue
        rects.append({"x0": x0, "top": top, "x1": x1, "bottom": bottom})
    clusters = []
    for cluster in _cluster_rects(rects):
        boxes = [(item["x0"], item["top"], item["x1"], item["bottom"]) for item in cluster]
        clusters.append(
            {
                "bbox": _union_bbox(boxes),
                "top": min(item["top"] for item in cluster),
                "bottom": max(item["bottom"] for item in cluster),
                "kind": "figure",
            }
        )
    return clusters


def _vector_clusters(page: pdfplumber.page.Page, page_height: float) -> List[Dict[str, Any]]:
    """Cluster actual vector drawing objects into figure candidates."""
    rects: List[Dict[str, float]] = []
    objects = list(page.curves) + list(page.lines)
    for item in objects:
        x0 = float(item.get("x0", 0))
        top = float(item.get("top", 0))
        x1 = float(item.get("x1", 0))
        bottom = float(item.get("bottom", 0))
        if top < 70 or bottom > page_height - 40:
            continue
        if abs(x1 - x0) < 0.8 and abs(bottom - top) < 0.8:
            continue
        if bottom - top <= 1.5 and x1 - x0 > float(page.width) * 0.8:
            # Full-width rules are table/page separators, not figure marks.
            continue
        rects.append({"x0": x0, "top": top, "x1": x1, "bottom": bottom})
    clusters = []
    for cluster in _cluster_rects(rects, gap=18.0):
        boxes = [(item["x0"], item["top"], item["x1"], item["bottom"]) for item in cluster]
        bbox = _union_bbox(boxes)
        width = bbox[2] - bbox[0]
        height = bbox[3] - bbox[1]
        if width < 12 or height < 12 or width * height < 800:
            continue
        clusters.append(
            {
                "bbox": bbox,
                "top": bbox[1],
                "bottom": bbox[3],
                "kind": "figure",
            }
        )
    return clusters


def _is_caption_continuation(previous: Dict[str, Any], candidate: Dict[str, Any]) -> bool:
    """Recognize the second/third line of a multi-line caption.

    Captions usually start lower-case on continuation lines and sit directly
    under the first line. Requiring lower-case also keeps a table body (which
    starts with an upper-case header) out of the caption.
    """
    if candidate["page"] != previous["page"] or candidate["role"] != "prose":
        return False
    text = candidate["text"].strip()
    if not text:
        return False
    if CAPTION_RE.match(text) or HEADING_RE.match(text):
        return False
    if re.match(r"^(Abstract|Keywords|References|Acknowledg)\b", text, re.I):
        return False
    gap = float(candidate["top"]) - float(previous["bottom"])
    size = max(float(previous["size"]), 1.0)
    starts_lower = text[:1].islower() or text[:1] in "(（"
    # A caption split at an existing hyphen may continue with an acronym or
    # model name (``(MobileViT-`` / ``XXSmall).``). The shared x-position and
    # tight leading are stronger evidence than capitalization in this case.
    previous_text = clean_text(previous.get("text", ""))
    previous_match = CAPTION_RE.match(previous_text)
    previous_is_bare_label = bool(previous_match and not clean_text(previous_match.group("rest") or ""))
    if previous_is_bare_label and gap <= 1.7 * size:
        if (
            (
                abs(float(candidate["x0"]) - float(previous["x0"])) <= 40
                or previous.get("columnScope") == "full"
            )
            and float(candidate["size"]) <= float(previous["size"]) + 1.5
            and text.isupper()
        ):
            return True
    if previous_text.endswith("-") and gap <= 1.7 * size:
        if abs(float(candidate["x0"]) - float(previous["x0"])) <= 40:
            return True
    if starts_lower:
        if gap > 1.7 * size:
            return False
    else:
        # A caption can start a new sentence on the next physical line.
        # Require a long sentence-like tail and near-zero leading, so an
        # immediately following body paragraph or a table header is not
        # swallowed into the figure caption.
        if len(text) < 60 or not re.search(r"[a-z]", text) or not re.search(r"[.;:]", text):
            return False
        if gap > 0.6 * size:
            return False
    if float(candidate["size"]) > float(previous["size"]) + 1.5:
        return False
    if abs(float(candidate["x0"]) - float(previous["x0"])) > 40:
        return False
    return True


def is_reference_entry_start(text: str) -> bool:
    """True for a numbered bibliography entry, not a citation-link tail."""
    value = clean_text(text)
    match = REFERENCE_ENTRY_RE.match(value)
    if not match:
        return False
    if match.group("plain") is not None and int(match.group("plain")) > 999:
        return False
    return not REFERENCE_LINK_ONLY_RE.fullmatch(value)


def _caption_blocks(lines: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    blocks = []
    for page in sorted({line["page"] for line in lines}):
        page_lines = [
            line
            for line in lines
            if line["page"] == page and line["role"] not in ("furniture", "figure_label")
        ]
        page_lines.sort(key=lambda item: (item["top"], item["x0"]))
        by_scope: Dict[str, List[Dict[str, Any]]] = {}
        for item in page_lines:
            by_scope.setdefault(str(item.get("columnScope")), []).append(item)
        i = 0
        while i < len(page_lines):
            if page_lines[i]["role"] != "caption":
                i += 1
                continue
            caption_line = page_lines[i]
            scope_lines = by_scope.get(str(caption_line.get("columnScope")), [caption_line])
            scope_index = next(
                (index for index, item in enumerate(scope_lines) if item["id"] == caption_line["id"]),
                0,
            )
            group = [caption_line]
            scope_cursor = scope_index + 1
            while scope_cursor < len(scope_lines) and _is_caption_continuation(
                group[-1],
                scope_lines[scope_cursor],
            ):
                group.append(scope_lines[scope_cursor])
                scope_cursor += 1
            match = CAPTION_RE.match(group[0]["text"])
            label_kind = match.group("kind").lower() if match else ""
            label_num = match.group("num") if match else ""
            blocks.append(
                {
                    "page": page,
                    "label_kind": "figure" if label_kind in ("figure", "fig.") else label_kind,
                    "label_num": label_num,
                    "text": clean_text(" ".join(item["text"] for item in group)),
                    "bbox": _union_bbox(
                        [(item["x0"], item["top"], item["x1"], item["bottom"]) for item in group]
                    ),
                    "columnScope": group[0].get("columnScope", "full"),
                    "top": float(group[0]["top"]),
                    "bottom": float(group[-1]["bottom"]),
                    "lines": group,
                }
            )
            i += 1
    return blocks


def annotate_table_bodies(lines: List[Dict[str, Any]], assets: List[Dict[str, Any]]) -> None:
    """Mark lines that belong to a table crop so they are not emitted twice."""
    table_assets = [asset for asset in assets if asset["kind"] == "table"]
    for asset in table_assets:
        if asset.get("borderless"):
            continue
        x0, _, x1, bottom = [float(value) for value in asset["bbox"]]
        page_lines = sorted(
            (
                line
                for line in lines
                if line["page"] == asset["page"]
                and line.get("role") not in (
                    "caption",
                    "furniture",
                    "meta",
                    "table_body",
                    "heading",
                    "references_heading",
                )
                and not HEADING_RE.match(clean_text(line.get("text", "")))
                and float(line["top"]) >= bottom - 2
                and x0 <= (float(line["x0"]) + float(line["x1"])) / 2 <= x1
            ),
            key=lambda line: float(line["top"]),
        )
        cursor_bottom = bottom
        for line in page_lines:
            text = clean_text(line["text"])
            gap = float(line["top"]) - cursor_bottom
            words = text.split()
            prose_like = (
                (text.endswith(".") and len(words) > 10)
                or (len(words) > 16 and text[:1].islower())
                or bool(re.match(r"^(?:Note|Notes|Source|PV)\s*:", text, re.I) and len(words) > 6)
            )
            if gap > max(24.0, 2.2 * float(line.get("size") or 9.0)) or prose_like:
                break
            asset["bbox"][3] = max(float(asset["bbox"][3]), float(line["bottom"]))
            cursor_bottom = float(asset["bbox"][3])
    for line in lines:
        if line["role"] in ("caption", "furniture", "figure_label"):
            continue
        center_x = (float(line["x0"]) + float(line["x1"])) / 2
        center_y = (float(line["top"]) + float(line["bottom"])) / 2
        for asset in table_assets:
            if asset["page"] != line["page"]:
                continue
            x0, top, x1, bottom = [float(value) for value in asset["bbox"]]
            if x0 <= center_x <= x1 and top <= center_y <= bottom:
                line["role"] = "table_body"
                break


def assign_figure_labels(lines: List[Dict[str, Any]], assets: List[Dict[str, Any]]) -> None:
    """Attach ``(a) (b)`` panel labels to the nearest figure crop."""
    figures = [asset for asset in assets if asset["kind"] == "figure"]
    for line in lines:
        if line["role"] != "figure_label":
            continue
        candidates = []
        center_x = (float(line["x0"]) + float(line["x1"])) / 2
        center_y = (float(line["top"]) + float(line["bottom"])) / 2
        for asset in figures:
            if asset["page"] != line["page"]:
                continue
            x0, top, x1, bottom = [float(value) for value in asset["bbox"]]
            if not (x0 - 35 <= center_x <= x1 + 35):
                continue
            if top - 70 <= center_y <= bottom + 70:
                distance = min(abs(center_y - top), abs(center_y - bottom))
                candidates.append((distance, asset))
        if candidates:
            _, asset = min(candidates, key=lambda item: item[0])
            asset.setdefault("labelIds", []).append(line["id"])
            label_box = (float(line["x0"]), float(line["top"]), float(line["x1"]), float(line["bottom"]))
            asset["bbox"] = list(_union_bbox([tuple(asset["bbox"]), label_box]))


def annotate_figure_texts(lines: List[Dict[str, Any]], assets: List[Dict[str, Any]]) -> None:
    """Assign diagram text inside a figure crop to that figure."""
    figures = [asset for asset in assets if asset["kind"] == "figure"]
    for asset in figures:
        scope = asset.get("columnScope")
        if scope not in ("left", "right"):
            continue
        scope_lines = [
            line
            for line in lines
            if line["page"] == asset["page"] and line.get("columnScope") == scope
        ]
        if not scope_lines:
            continue
        column_x0 = min(float(line["x0"]) for line in scope_lines)
        column_x1 = max(float(line["x1"]) for line in scope_lines)
        width = float(asset["bbox"][2]) - float(asset["bbox"][0])
        if width < (column_x1 - column_x0) * 0.55:
            asset["bbox"][0] = max(0.0, column_x0 - 2)
            asset["bbox"][2] = column_x1 + 2
    for line in lines:
        if line.get("role") in ("caption", "furniture", "meta", "table_body"):
            continue
        center_x = (float(line["x0"]) + float(line["x1"])) / 2
        center_y = (float(line["top"]) + float(line["bottom"])) / 2
        for asset in figures:
            if asset["page"] != line["page"]:
                continue
            x0, top, x1, bottom = [float(value) for value in asset["bbox"]]
            if x0 <= center_x <= x1 and top <= center_y <= bottom:
                line["role"] = "figure_label"
                asset.setdefault("labelIds", []).append(line["id"])
                break


def _table_region(
    page: pdfplumber.page.Page,
    caption: Dict[str, Any],
    page_height: float,
) -> Optional[Tuple[float, float, float, float]]:
    """Use the visible horizontal rules below a table caption to find its body."""
    rules = _horizontal_rules(page)
    start = float(caption["bottom"]) + 2
    candidates = sorted(
        [rule for rule in rules if start <= rule["top"] <= page_height - 40],
        key=lambda rule: rule["top"],
    )
    if len(candidates) < 2:
        return None
    # A table's rules form one vertical chain. Stop at a large break instead
    # of imposing a fixed 260 pt ceiling: long tables routinely exceed that,
    # and the old limit silently cut every lower row out of the crop.
    max_gap = max(72.0, page_height * 0.09)
    chain = [candidates[0]]
    for rule in candidates[1:]:
        if rule["top"] - chain[-1]["top"] > max_gap:
            break
        chain.append(rule)
    if len(chain) < 2:
        return None
    candidates = chain
    top = min(rule["top"] for rule in candidates)
    bottom = max(rule["top"] for rule in candidates)
    if bottom - top < 8:
        return None
    return (
        min(rule["x0"] for rule in candidates),
        top - 4,
        max(rule["x1"] for rule in candidates),
        min(page_height - 40, bottom + 4),
    )


def _borderless_table_region(
    lines: List[Dict[str, Any]],
    caption: Dict[str, Any],
    body_size: float,
    page_width: float,
    page_height: float,
) -> Optional[Tuple[float, float, float, float]]:
    """Infer a dense table from typography when the PDF draws no rules.

    Literature-review tables often use a 5-7 pt grid with no cell borders.
    A fixed crop is still better than flattening every row into prose. The
    region starts after the caption/title and stops at the next caption,
    heading, or body-sized prose line.
    """
    start = float(caption["bottom"]) + 1.0
    scope = caption.get("columnScope")
    caption_center = (float(caption["bbox"][0]) + float(caption["bbox"][2])) / 2
    centered = abs(caption_center - page_width / 2) <= page_width * 0.12
    if centered:
        include_scopes = None
    elif scope == "full":
        include_scopes = {"right" if caption_center > page_width / 2 else "left"}
    else:
        include_scopes = {scope}
    candidates: List[Dict[str, Any]] = []
    for line in sorted(
        (item for item in lines if item["page"] == caption["page"] and float(item["top"]) >= start),
        key=lambda item: float(item["top"]),
    ):
        top = float(line["top"])
        if top > page_height - 35:
            break
        text = clean_text(line["text"])
        role = line.get("role")
        if include_scopes is not None and line.get("columnScope") not in include_scopes:
            continue
        if role == "caption" and CAPTION_RE.match(text):
            break
        if role in ("heading", "references_heading") and text:
            break
        if role in ("furniture", "meta"):
            continue
        size = float(line.get("size") or 0.0)
        if size >= body_size - 0.25 and len(text.split()) >= 5:
            break
        if size <= body_size - 0.2 or line.get("bold"):
            candidates.append(line)
    if len(candidates) < 3:
        return None
    bbox = _union_bbox(
        [(item["x0"], item["top"], item["x1"], item["bottom"]) for item in candidates]
    )
    # Include the caption's horizontal extent so a wide table is not clipped
    # to the narrower union of its text fragments.
    bbox[0] = min(bbox[0], float(caption["bbox"][0]))
    bbox[2] = max(bbox[2], float(caption["bbox"][2]))
    return (bbox[0] - 2, bbox[1] - 2, bbox[2] + 2, min(page_height - 35, bbox[3] + 3))


def _borderless_figure_region(
    lines: List[Dict[str, Any]],
    caption: Dict[str, Any],
    body_size: float,
    page_width: float,
) -> Optional[Tuple[float, float, float, float]]:
    """Infer a vector diagram above a figure caption."""
    scope = caption.get("columnScope")
    caption_center = (float(caption["bbox"][0]) + float(caption["bbox"][2])) / 2
    if scope == "full":
        scope = "right" if caption_center > page_width / 2 else "left"
    candidates: List[Dict[str, Any]] = []
    last_top = float(caption["top"])
    for line in sorted(
        (
            item
            for item in lines
            if item["page"] == caption["page"]
            and item.get("columnScope") == scope
            and float(item["bottom"]) <= float(caption["top"]) + 1
        ),
        key=lambda item: float(item["top"]),
        reverse=True,
    ):
        gap = last_top - float(line["bottom"])
        role = line.get("role")
        text = clean_text(line["text"])
        size = float(line.get("size") or 0.0)
        if gap > 45 or role in ("heading", "references_heading", "caption"):
            break
        if size >= body_size - 0.2 and len(text.split()) >= 5:
            break
        candidates.append(line)
        last_top = float(line["top"])
        if len(candidates) >= 80:
            break
    if len(candidates) < 2:
        return None
    bbox = _union_bbox(
        [(item["x0"], item["top"], item["x1"], item["bottom"]) for item in candidates]
    )
    bbox[0] = min(bbox[0], float(caption["bbox"][0]))
    bbox[2] = max(bbox[2], float(caption["bbox"][2]))
    return (bbox[0] - 3, max(40.0, bbox[1] - 3), bbox[2] + 3, float(caption["top"]) - 2)


def _equation_regions(lines: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    regions = []
    for page in sorted({line["page"] for line in lines}):
        page_lines = [line for line in lines if line["page"] == page]
        page_lines.sort(key=lambda item: (item["top"], item["x0"]))
        i = 0
        while i < len(page_lines):
            line = page_lines[i]
            if line["role"] != "equation" or not EQUATION_RE.search(line["text"]):
                i += 1
                continue
            group = [line]
            # A formula often starts on the line above (radical glyphs, etc.).
            if i > 0 and page_lines[i - 1]["role"] == "equation":
                group.insert(0, page_lines[i - 1])
            # Include an unnumbered math limit immediately after the numbered
            # equation line. It is visually part of the same display formula.
            j = i + 1
            while j < len(page_lines):
                following = page_lines[j]
                if following["role"] != "equation" or EQUATION_RE.search(following["text"]):
                    break
                text = clean_text(following["text"])
                if len(text) > 48 or not MATH_LIMIT_RE.fullmatch(text):
                    break
                group.append(following)
                j += 1
            bbox = _union_bbox([(item["x0"], item["top"], item["x1"], item["bottom"]) for item in group])
            regions.append(
                {
                    "page": page,
                    "kind": "equation",
                    "label": "Equation " + EQUATION_RE.search(line["text"]).group("num"),
                    "bbox": [bbox[0] - 8, bbox[1] - 6, bbox[2] + 8, bbox[3] + 6],
                    "lines": group,
                }
            )
            i += 1
    # Adjacent numbered equations can be emitted as overlapping line boxes.
    # Merge them into one crop instead of rendering the same region twice.
    merged: List[Dict[str, Any]] = []
    for region in sorted(regions, key=lambda item: (item["page"], item["bbox"][1])):
        if not merged:
            merged.append(region)
            continue
        previous = merged[-1]
        if previous["page"] != region["page"]:
            merged.append(region)
            continue
        ax0, ay0, ax1, ay1 = [float(value) for value in previous["bbox"]]
        bx0, by0, bx1, by1 = [float(value) for value in region["bbox"]]
        overlap_w = max(0.0, min(ax1, bx1) - max(ax0, bx0))
        overlap_h = max(0.0, min(ay1, by1) - max(ay0, by0))
        overlap = overlap_w * overlap_h
        smaller = min((ax1 - ax0) * (ay1 - ay0), (bx1 - bx0) * (by1 - by0))
        if smaller > 0 and overlap / smaller > 0.3:
            previous["bbox"] = list(
                _union_bbox([tuple(previous["bbox"]), tuple(region["bbox"])])
            )
            previous["lines"] = previous.get("lines", []) + region.get("lines", [])
            previous["label"] = "Equation " + previous["label"].split()[-1] + "–" + region["label"].split()[-1]
        else:
            merged.append(region)
    return merged


def detect_assets(
    pdf_path: Path,
    lines: List[Dict[str, Any]],
    page_count: int,
) -> List[Dict[str, Any]]:
    captions = _caption_blocks(lines)
    body_size = estimate_body_size(lines)
    assets: List[Dict[str, Any]] = []
    used_caption_ids = set()

    with pdfplumber.open(str(pdf_path)) as pdf:
        for page_index, page in enumerate(pdf.pages):
            if page_index >= page_count:
                break
            page_no = page_index + 1
            page_height = float(page.height)
            clusters = _image_clusters(page, page_height) + _vector_clusters(page, page_height)
            page_captions = [caption for caption in captions if caption["page"] == page_no]
            figure_captions = sorted(
                [caption for caption in page_captions if caption["label_kind"] == "figure"],
                key=lambda item: float(item["top"]),
            )

            for caption_index, caption in enumerate(page_captions):
                if caption["label_kind"] == "figure":
                    # A full-page figure can be several image panels separated
                    # by large gaps. Use the previous figure caption as the
                    # lower bound of this figure's vertical window.
                    figure_index = figure_captions.index(caption)
                    previous_top = (
                        float(figure_captions[figure_index - 1]["top"])
                        if figure_index > 0
                        else 0.0
                    )
                    candidates = [
                        cluster
                        for cluster in clusters
                        if cluster["bottom"] <= float(caption["top"]) + 10
                        and cluster["top"] >= previous_top - 5
                        and float(cluster["bbox"][0]) <= float(caption["bbox"][2]) + 30
                        and float(cluster["bbox"][2]) >= float(caption["bbox"][0]) - 30
                    ]
                    if candidates:
                        bbox = _expanded(
                            tuple(
                                _union_bbox([tuple(cluster["bbox"]) for cluster in candidates])
                            ),
                            2.0,
                        )
                        assets.append(
                            {
                                "page": page_no,
                                "kind": "figure",
                                "label": f"Figure {caption['label_num']}",
                                "bbox": list(bbox),
                                "caption": caption["text"],
                                "caption_bbox": caption["bbox"],
                                "columnScope": caption.get("columnScope", "full"),
                            }
                        )
                        used_caption_ids.add(id(caption))
                    else:
                        fallback = _borderless_figure_region(
                            lines,
                            caption,
                            body_size,
                            float(page.width),
                        )
                        if fallback is not None:
                            assets.append(
                                {
                                    "page": page_no,
                                    "kind": "figure",
                                    "label": f"Figure {caption['label_num']}",
                                    "bbox": list(fallback),
                                    "caption": caption["text"],
                                    "caption_bbox": caption["bbox"],
                                    "columnScope": caption.get("columnScope", "full"),
                                    "borderless": True,
                                }
                            )
                            used_caption_ids.add(id(caption))
                elif caption["label_kind"] == "table":
                    rule_region = _table_region(page, caption, page_height)
                    borderless_region = _borderless_table_region(
                        lines,
                        caption,
                        body_size,
                        float(page.width),
                        page_height,
                    )
                    if borderless_region is not None:
                        region = borderless_region
                        borderless = True
                    else:
                        region = rule_region
                        borderless = False
                    if region is not None:
                        assets.append(
                            {
                                "page": page_no,
                                "kind": "table",
                                "label": f"Table {caption['label_num']}",
                                "bbox": list(region),
                                "caption": caption["text"],
                                "caption_bbox": caption["bbox"],
                                "borderless": borderless,
                            }
                        )
                        used_caption_ids.add(id(caption))

    for equation in _equation_regions(lines):
        assets.append(equation)

    # A caption that could not be matched still becomes a visible caption
    # block; it is not silently dropped.
    for caption in captions:
        if id(caption) not in used_caption_ids:
            assets.append(
                {
                    "page": caption["page"],
                    "kind": "caption",
                    "label": f"{caption['label_kind'].title()} {caption['label_num']}".strip(),
                    "bbox": list(caption["bbox"]),
                    "caption": caption["text"],
                    "caption_bbox": caption["bbox"],
                }
            )

    assets.sort(key=lambda item: (item["page"], item["bbox"][1], item["bbox"][0]))
    return assets


def rotated_table_assets(pdf_path: Path, rotated_pages: set[int]) -> List[Dict[str, Any]]:
    """Turn full-page sideways tables into upright table images."""
    if not rotated_pages:
        return []
    assets: List[Dict[str, Any]] = []
    doc = pdfium.PdfDocument(str(pdf_path))
    try:
        with pdfplumber.open(str(pdf_path)) as pdf:
            for page_no in sorted(rotated_pages):
                width, height = [float(value) for value in doc[page_no - 1].get_size()]
                raw = ""
                try:
                    raw = pdf.pages[page_no - 1].extract_text() or ""
                except Exception:
                    raw = ""
                # pdfplumber sees sideways glyphs as a reversed matrix. Pdfium
                # exposes the same text layer in reading order, which is enough
                # to reconstruct dense rotated tables without OCR.
                try:
                    pdfium_text = doc[page_no - 1].get_textpage().get_text_range().replace("\r", "")
                    if pdfium_text.strip():
                        raw = pdfium_text
                except Exception:
                    pass
                raw_lines = [
                    line.strip()
                    for line in raw.splitlines()
                    if line.strip() and not re.fullmatch(r"[.\s]+", line.strip())
                ]
                header_index = next(
                    (
                        index
                        for index, line in enumerate(raw_lines)
                        if re.search(r"\bStrain\b.*\bOrganism\b.*\bState\b", line, re.I)
                    ),
                    None,
                )
                if header_index is not None:
                    end = len(raw_lines)
                    for index in range(header_index + 1, len(raw_lines)):
                        line = raw_lines[index]
                        if (
                            re.search(r"PLoS ONE|Drug Resistance in Y\.|doi:10\.|aamikacin|bPCR|cEstimated|^\s*cont\.?$", line, re.I)
                        ):
                            end = index
                            break
                    raw = "\n".join(raw_lines[header_index:end])
                # Table titles are reversed by the 90/270-degree glyph matrix.
                label = "Table 2" if re.search(r"2elbaT|elbaT\s*\.?\s*2", raw, re.I) else "Table"
                caption = f"{label}. Rotated table on page {page_no}; preserved as an image and rotated upright."
                assets.append(
                    {
                        "page": page_no,
                        "kind": "table",
                        "label": label,
                        "bbox": [0.0, 0.0, width, height],
                        "caption": caption,
                        "text": raw,
                        "rotatedPage": True,
                        "rotate": -90,
                    }
                )
    finally:
        doc.close()
    return assets


# ---------------------------------------------------------------------------
# Cropping
# ---------------------------------------------------------------------------


def crop_assets(
    pdf_path: Path,
    assets: List[Dict[str, Any]],
    out_dir: Path,
    dpi: int = 200,
) -> None:
    """Render each source page once and crop every asset from it."""
    assets_dir = out_dir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    doc = pdfium.PdfDocument(str(pdf_path))
    scale = dpi / 72.0
    page_cache: Dict[int, Image.Image] = {}
    counters: Dict[str, int] = {}
    try:
        for asset in assets:
            if asset["kind"] == "caption":
                asset["image"] = ""
                continue
            page_no = int(asset["page"])
            if page_no not in page_cache:
                page = doc[page_no - 1]
                page_cache[page_no] = page.render(scale=scale).to_pil().convert("RGB")
            image = page_cache[page_no]
            page_width, page_height = float(doc[page_no - 1].get_size()[0]), float(doc[page_no - 1].get_size()[1])
            x0, top, x1, bottom = [float(value) for value in asset["bbox"]]
            x0 = max(0.0, min(page_width, x0))
            x1 = max(0.0, min(page_width, x1))
            top = max(0.0, min(page_height, top))
            bottom = max(0.0, min(page_height, bottom))
            if x1 - x0 < 2 or bottom - top < 2:
                asset["image"] = ""
                continue
            box = (
                int(round(x0 * scale)),
                int(round(top * scale)),
                int(round(x1 * scale)),
                int(round(bottom * scale)),
            )
            crop = image.crop(box)
            if asset.get("rotate"):
                crop = crop.rotate(float(asset["rotate"]), expand=True, fillcolor="white")
            kind = asset["kind"]
            counters[kind] = counters.get(kind, 0) + 1
            filename = f"{kind}-{counters[kind]:02d}.png"
            crop.save(assets_dir / filename, "PNG", optimize=True)
            asset["image"] = "assets/" + filename
            asset["imageSize"] = list(crop.size)
    finally:
        doc.close()


def render_source_pages(pdf_path: Path, out_dir: Path, dpi: int = 110) -> None:
    pages_dir = out_dir / "source-pages"
    pages_dir.mkdir(parents=True, exist_ok=True)
    doc = pdfium.PdfDocument(str(pdf_path))
    scale = dpi / 72.0
    try:
        for page_index in range(len(doc)):
            image = doc[page_index].render(scale=scale).to_pil().convert("RGB")
            image.save(pages_dir / f"page-{page_index + 1:02d}.png", "PNG", optimize=True)
    finally:
        doc.close()


# ---------------------------------------------------------------------------
# Block assembly
# ---------------------------------------------------------------------------


def _complete_terms(lines: Iterable[Dict[str, Any]]) -> set[str]:
    """Collect evidence for deciding whether a line-end hyphen is lexical."""
    terms: set[str] = set()
    for line in lines:
        text = clean_text(line.get("text", ""))
        trailing = re.search(r"([A-Za-z]+)-$", text)
        for match in re.finditer(r"(?<![A-Za-z])([A-Za-z]+(?:-[A-Za-z]+)*)(?![A-Za-z])", text):
            token = match.group(1).lower()
            if trailing and token == trailing.group(1).lower() and match.end() == len(text) - 1:
                continue
            terms.add(token)
    return terms


def _remove_line_hyphen(stem: str, prefix: str, complete_terms: Optional[set[str]]) -> bool:
    if complete_terms is None:
        return True
    joined = (stem + prefix).lower()
    lexical = (stem + "-" + prefix).lower()
    if joined in complete_terms:
        return True
    if lexical in complete_terms:
        return False
    # An unseen concatenation is ambiguous. Preserve the visible hyphen
    # instead of silently manufacturing a non-word such as "domainspecific".
    return False


def _join_lines(texts: List[str], complete_terms: Optional[set[str]] = None) -> str:
    """Join wrapped lines, undoing conservative end-of-line hyphenation."""
    out = ""
    for text in texts:
        text = text.strip()
        if not text:
            continue
        if not out:
            out = text
            continue
        if out.endswith("-") and text[:1].islower():
            stem_match = re.search(r"([A-Za-z]+)-$", out)
            prefix_match = re.match(r"([A-Za-z]+)", text)
            if (
                stem_match
                and prefix_match
                and _remove_line_hyphen(
                    stem_match.group(1),
                    prefix_match.group(1),
                    complete_terms,
                )
            ):
                out = out[:-1] + text
            else:
                out += text
        else:
            out += " " + text
    return clean_text(out)


def _asset_for_caption(
    caption: Dict[str, Any],
    assets: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    candidates = []
    for asset in assets:
        if asset["page"] != caption["page"] or asset["kind"] == "caption":
            continue
        caption_box = tuple(caption["bbox"])
        asset_caption = asset.get("caption_bbox")
        if asset_caption and tuple(asset_caption) == caption_box:
            candidates.append(asset)
    return candidates[0] if candidates else None


def _table_body_lines(asset: Dict[str, Any], lines: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    selected = []
    x0, top, x1, bottom = [float(value) for value in asset["bbox"]]
    for line in lines:
        if line["page"] != asset["page"] or line["role"] != "table_body":
            continue
        center_x = (float(line["x0"]) + float(line["x1"])) / 2
        center_y = (float(line["top"]) + float(line["bottom"])) / 2
        if x0 <= center_x <= x1 and top <= center_y <= bottom:
            selected.append(line)
    return selected


def _algorithm_steps(
    body_lines: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Preserve algorithm lines and their control-flow depth."""
    steps: List[Dict[str, Any]] = []
    stack: List[str] = []
    left_edges = [
        float(line["x0"])
        for line in body_lines
        if not ALGORITHM_BOUNDARY_RE.fullmatch(clean_text(line["text"]))
    ]
    left = min(left_edges, default=0.0)
    for line in body_lines:
        text = clean_text(line["text"])
        if ALGORITHM_BOUNDARY_RE.fullmatch(text):
            continue
        match = ALGORITHM_STEP_RE.match(text)
        statement = match.group("text").strip() if match else text
        upper = statement.upper()
        line_depth: Optional[int] = None
        is_else = bool(re.match(r"^ELSE(?:\s+IF)?\b", upper))
        if re.match(r"^END\s*WHILE\b", upper):
            index = next((i for i in range(len(stack) - 1, -1, -1) if stack[i] == "WHILE"), None)
            stack = stack[:index] if index is not None else []
        elif re.match(r"^END\s*(?:FUNCTION|PROCEDURE)\b", upper):
            index = next(
                (i for i in range(len(stack) - 1, -1, -1) if stack[i] in ("FUNCTION", "PROCEDURE")),
                None,
            )
            stack = stack[:index] if index is not None else []
        elif re.match(r"^END\s*IF\b", upper):
            index = next((i for i in range(len(stack) - 1, -1, -1) if stack[i] == "IF"), None)
            stack = stack[:index] if index is not None else []
        elif is_else:
            index = next((i for i in range(len(stack) - 1, -1, -1) if stack[i] == "IF"), None)
            if index is not None:
                stack = stack[:index]
                line_depth = len(stack)
        depth = len(stack) if line_depth is None else line_depth
        steps.append(
            {
                "number": int(match.group("number")) if match else None,
                "text": text,
                "depth": depth,
                "indent": round(max(0.0, float(line["x0"]) - left), 2),
                "sourceId": line["id"],
                "page": line["page"],
            }
        )
        if re.match(r"^WHILE\b", upper):
            stack.append("WHILE")
        elif re.match(r"^IF\b|^ELSE\s+IF\b", upper):
            stack.append("IF")
        elif re.match(r"^(?:FOR|FOREACH)\b", upper):
            stack.append("FOR")
        elif re.match(r"^(?:FUNCTION|PROCEDURE)\b", upper):
            stack.append("FUNCTION")
        elif is_else:
            stack.append("IF")
    return steps


def _collect_algorithm(
    lines: List[Dict[str, Any]],
    caption_index: int,
    caption_end: int,
    caption_text: str,
) -> Optional[Tuple[Dict[str, Any], int]]:
    """Collect ``Algorithm caption -> BEGIN -> numbered steps -> END``.

    The caller has already resolved caption continuation lines. The result is
    accepted only when an enclosing END and at least two numbered steps are
    visible, so a normal paragraph mentioning "Algorithm" cannot absorb body
    text.
    """
    if caption_index >= len(lines) or caption_end >= len(lines):
        return None
    page = int(lines[caption_index]["page"])
    scope = lines[caption_index].get("columnScope")
    body: List[Dict[str, Any]] = []
    cursor = caption_end
    if cursor < len(lines) and re.fullmatch(r"BEGIN", clean_text(lines[cursor]["text"]), re.I):
        found_end = False
        while cursor < len(lines):
            line = lines[cursor]
            if int(line["page"]) != page or line.get("columnScope") != scope:
                break
            text = clean_text(line["text"])
            if re.fullmatch(r"END", text, re.I):
                body.append(line)
                cursor += 1
                found_end = True
                break
            if line.get("role") == "caption":
                break
            body.append(line)
            cursor += 1
        if not found_end:
            return None
    else:
        body_size = estimate_body_size(lines)
        while cursor < len(lines):
            line = lines[cursor]
            if int(line["page"]) != page or line.get("columnScope") != scope:
                break
            text = clean_text(line["text"])
            role = line.get("role")
            if role == "caption" or (role in ("heading", "references_heading") and text):
                break
            size = float(line.get("size") or 0.0)
            if body and size >= body_size - 0.25:
                break
            indented = float(line.get("x0") or 0.0) > float(lines[caption_index].get("x0") or 0.0) + 2.0
            if not body and not (ALGORITHM_CUE_RE.match(text) or indented or size <= body_size - 0.3):
                break
            body.append(line)
            cursor += 1
        if len(body) < 2:
            return None
    steps = _algorithm_steps(body)
    if len(steps) < 2:
        return None
    caption_lines = lines[caption_index:caption_end]
    all_lines = caption_lines + body
    label_match = CAPTION_RE.match(caption_text)
    label = (
        f"{label_match.group('kind').title()} {label_match.group('num')}"
        if label_match
        else "Algorithm"
    )
    algorithm_text = "\n".join(
        ("  " * int(step["depth"])) + str(step["text"]) for step in steps
    )
    return (
        {
            "type": "algorithm",
            "text": caption_text,
            "caption": caption_text,
            "label": label,
            "algorithmText": algorithm_text,
            "steps": steps,
            "page": page,
            "bbox": _union_bbox(
                [
                    (item["x0"], item["top"], item["x1"], item["bottom"])
                    for item in all_lines
                ]
            ),
            "sourceIds": [item["id"] for item in all_lines],
        },
        cursor,
    )


def build_blocks(lines: List[Dict[str, Any]], assets: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Turn classified lines into ordered MirrorDoc blocks."""
    blocks: List[Dict[str, Any]] = []
    complete_terms = _complete_terms(lines)

    def join_lines(values: List[str]) -> str:
        return _join_lines(values, complete_terms)

    section = ""
    in_references = False
    references_started = False
    body_left_cache: Dict[tuple, float] = {}
    i = 0
    while i < len(lines):
        line = lines[i]
        role = line["role"]
        if role in ("furniture", "figure_label", "table_body", "meta"):
            i += 1
            continue

        # ACKNOWLEDGMENTS and supporting-info blocks can interrupt the
        # reference list in the second column; a numbered entry still belongs
        # to the reference list when the list has already started.
        if references_started and role == "prose" and is_reference_entry_start(line["text"]):
            in_references = True

        if role == "title":
            group = [line]
            j = i + 1
            while j < len(lines) and lines[j]["role"] == "title" and lines[j]["page"] == line["page"]:
                group.append(lines[j])
                j += 1
            blocks.append(
                {
                    "type": "title",
                    "text": join_lines([item["text"] for item in group]),
                    "page": line["page"],
                    "bbox": _union_bbox(
                        [(item["x0"], item["top"], item["x1"], item["bottom"]) for item in group]
                    ),
                    "sourceIds": [item["id"] for item in group],
                }
            )
            i = j
            continue

        if role == "heading":
            heading_group = [line]
            j = i + 1
            while (
                j < len(lines)
                and lines[j].get("role") == "heading_continuation"
                and lines[j]["page"] == line["page"]
                and lines[j].get("columnScope") == line.get("columnScope")
            ):
                heading_group.append(lines[j])
                j += 1
            heading_text = join_lines([item["text"] for item in heading_group])
            match = HEADING_RE.match(heading_text)
            level = len(match.group("num").split(".")) if match else 1
            section = heading_text
            blocks.append(
                {
                    "type": "heading",
                    "text": heading_text,
                    "level": level,
                    "section": section,
                    "page": line["page"],
                    "bbox": _union_bbox(
                        [
                            (item["x0"], item["top"], item["x1"], item["bottom"])
                            for item in heading_group
                        ]
                    ),
                    "sourceIds": [item["id"] for item in heading_group],
                }
            )
            in_references = False
            i = j
            continue

        if role == "references_heading":
            section = line["text"]
            blocks.append(
                {
                    "type": "heading",
                    "text": line["text"],
                    "level": 1,
                    "section": section,
                    "page": line["page"],
                    "bbox": [line["x0"], line["top"], line["x1"], line["bottom"]],
                    "sourceIds": [line["id"]],
                }
            )
            in_references = True
            references_started = True
            i += 1
            continue

        if role == "abstract":
            group = [line]
            j = i + 1
            while j < len(lines):
                nxt = lines[j]
                if nxt["role"] == "keywords" or nxt["role"] in ("heading", "furniture"):
                    break
                group.append(nxt)
                j += 1
            text = join_lines([item["text"] for item in group])
            text = re.sub(r"^Abstract\b\s*[:—–-]?\s*", "", text, flags=re.I)
            blocks.append(
                {
                    "type": "abstract",
                    "text": text,
                    "section": "Abstract",
                    "page": line["page"],
                    "bbox": _union_bbox(
                        [(item["x0"], item["top"], item["x1"], item["bottom"]) for item in group]
                    ),
                    "sourceIds": [item["id"] for item in group],
                }
            )
            i = j
            continue

        if role == "keywords":
            text = re.sub(r"^(?:Keywords|Index Terms)\s*[:—–-]\s*", "", line["text"], flags=re.I)
            blocks.append(
                {
                    "type": "keywords",
                    "text": text,
                    "section": "Keywords",
                    "page": line["page"],
                    "bbox": [line["x0"], line["top"], line["x1"], line["bottom"]],
                    "sourceIds": [line["id"]],
                }
            )
            i += 1
            continue

        if role == "caption":
            group = [line]
            j = i + 1
            while j < len(lines) and _is_caption_continuation(group[-1], lines[j]):
                group.append(lines[j])
                j += 1
            caption = {
                "page": line["page"],
                "bbox": _union_bbox(
                    [(item["x0"], item["top"], item["x1"], item["bottom"]) for item in group]
                ),
                "text": join_lines([item["text"] for item in group]),
            }
            algorithm_match = CAPTION_RE.match(line["text"])
            if algorithm_match and algorithm_match.group("kind").lower() == "algorithm":
                collected = _collect_algorithm(lines, i, j, caption["text"])
                if collected is not None:
                    algorithm, next_index = collected
                    blocks.append(algorithm)
                    i = next_index
                    continue
            asset = _asset_for_caption(caption, assets)
            if asset is not None:
                body_text = ""
                asset_lines: List[Dict[str, Any]] = []
                if asset["kind"] == "table":
                    body_lines = _table_body_lines(asset, lines)
                    # Keep visual row boundaries in the machine-readable table
                    # text. The display can still use the original crop; later
                    # translation/table tools no longer receive one flattened
                    # pseudo-paragraph.
                    body_text = "\n".join(clean_text(item["text"]) for item in body_lines)
                    asset_lines = body_lines
                elif asset["kind"] == "figure":
                    x0, top, x1, bottom = [float(value) for value in asset["bbox"]]
                    asset_lines = [
                        item
                        for item in lines
                        if item["page"] == asset["page"]
                        and item["role"] == "figure_label"
                        and x0 <= (float(item["x0"]) + float(item["x1"])) / 2 <= x1
                        and top <= (float(item["top"]) + float(item["bottom"])) / 2 <= bottom
                    ]
                    label_ids = set(asset.get("labelIds", []))
                    asset_lines += [item for item in lines if item["id"] in label_ids]
                blocks.append(
                    {
                        "type": asset["kind"] if asset["kind"] in ("figure", "table") else "figure",
                        "text": join_lines([asset["caption"], body_text]) if body_text else asset["caption"],
                        "caption": asset["caption"],
                        "tableText": asset.get("text") or body_text,
                        "label": asset["label"],
                        "asset": asset.get("image", ""),
                        "rotatedPage": bool(asset.get("rotatedPage")),
                        "page": line["page"],
                        "bbox": asset["bbox"],
                        "captionBbox": asset["caption_bbox"],
                        "sourceIds": [item["id"] for item in group]
                        + [item["id"] for item in asset_lines],
                    }
                )
            else:
                blocks.append(
                    {
                        "type": "caption",
                        "text": caption["text"],
                        "page": line["page"],
                        "bbox": caption["bbox"],
                        "sourceIds": [item["id"] for item in group],
                    }
                )
            i = j
            continue

        if role == "equation":
            group = [line]
            j = i + 1
            while j < len(lines) and lines[j]["role"] == "equation" and lines[j]["page"] == line["page"]:
                group.append(lines[j])
                j += 1
            # Match the equation crop by page + overlapping bbox.
            bbox = _union_bbox([(item["x0"], item["top"], item["x1"], item["bottom"]) for item in group])
            asset = None
            for candidate in assets:
                if candidate["kind"] != "equation" or candidate["page"] != line["page"]:
                    continue
                if _overlaps(tuple(candidate["bbox"]), tuple(bbox)):
                    asset = candidate
                    break
            blocks.append(
                {
                    "type": "equation",
                    "text": join_lines([item["text"] for item in group]),
                    "label": asset["label"] if asset else "Equation",
                    "asset": asset.get("image", "") if asset else "",
                    "page": line["page"],
                    "bbox": asset["bbox"] if asset else bbox,
                    "sourceIds": [item["id"] for item in group],
                }
            )
            i = j
            continue

        if in_references:
            # References often run across page boundaries. Collect the whole
            # remaining reference run, then split it on visible entry numbers.
            group = [line]
            j = i + 1
            while j < len(lines):
                nxt = lines[j]
                if nxt["role"] in ("heading", "references_heading"):
                    break
                if nxt["role"] in ("furniture", "figure_label", "table_body"):
                    j += 1
                    continue
                if nxt["role"] != "prose":
                    break
                group.append(nxt)
                j += 1
            entries: List[List[Dict[str, Any]]] = []
            current: List[Dict[str, Any]] = []
            for item in group:
                if is_reference_entry_start(item["text"]):
                    if current:
                        entries.append(current)
                    current = [item]
                elif current:
                    current.append(item)
            if current:
                entries.append(current)
            for entry_lines in entries:
                first = entry_lines[0]
                blocks.append(
                    {
                        "type": "reference",
                        "text": join_lines([item["text"] for item in entry_lines]),
                        "section": section,
                        "page": first["page"],
                        "bbox": _union_bbox(
                            [
                                (item["x0"], item["top"], item["x1"], item["bottom"])
                                for item in entry_lines
                            ]
                        ),
                        "sourceIds": [item["id"] for item in entry_lines],
                    }
                )
            i = j
            continue

        # Prose paragraph. A paragraph boundary is either a vertical gap
        # larger than normal leading, or an indented first line. Using both
        # signals keeps tabs/indents from being flattened into one giant
        # block while still merging wrapped lines correctly.
        scope_key = (line["page"], line.get("columnScope"))
        if scope_key not in body_left_cache:
            body_left_cache[scope_key] = min(
                (
                    float(item["x0"])
                    for item in lines
                    if item["page"] == line["page"]
                    and item.get("columnScope") == line.get("columnScope")
                    and item["role"] == "prose"
                ),
                default=float(line["x0"]),
            )
        body_left = body_left_cache[scope_key]
        group = [line]
        j = i + 1
        while j < len(lines):
            nxt = lines[j]
            if (
                nxt["page"] != line["page"]
                or nxt["role"] != "prose"
                or nxt.get("columnScope") != line.get("columnScope")
            ):
                break
            gap = float(nxt["top"]) - float(group[-1]["bottom"])
            if gap > max(3.0, 0.28 * max(float(group[-1]["size"]), 1.0)):
                break
            indent = float(nxt["x0"]) - body_left
            if indent > max(1.5, 0.5 * max(float(nxt["size"]), 1.0)):
                break
            group.append(nxt)
            j += 1
        text = join_lines([item["text"] for item in group])
        indent = max(0.0, float(line["x0"]) - body_left)
        previous_bottom = (
            float(blocks[-1]["bbox"][3])
            if blocks and blocks[-1].get("bbox")
            else float(line["top"])
        )
        space_before = max(0.0, float(line["top"]) - previous_bottom)
        blocks.append(
            {
                "type": "paragraph",
                "text": text,
                "section": section,
                "page": line["page"],
                "indent": round(indent, 2),
                "spaceBefore": round(space_before, 2),
                "bbox": _union_bbox(
                    [(item["x0"], item["top"], item["x1"], item["bottom"]) for item in group]
                ),
                "sourceIds": [item["id"] for item in group],
            }
        )
        i = j
    return blocks


def attach_equation_assets(blocks: List[Dict[str, Any]], assets: List[Dict[str, Any]]) -> None:
    """Fill equation block assets after all blocks are assembled."""
    for block in blocks:
        if block["type"] != "equation" or block.get("asset"):
            continue
        for asset in assets:
            if asset["kind"] == "equation" and asset["page"] == block["page"]:
                if _overlaps(tuple(asset["bbox"]), tuple(block["bbox"])):
                    block["asset"] = asset.get("image", "")
                    block["label"] = asset["label"]
                    break


# ---------------------------------------------------------------------------
# Metadata and coverage
# ---------------------------------------------------------------------------


def extract_metadata(lines: List[Dict[str, Any]], pdf_path: Path, page_count: int) -> Dict[str, Any]:
    first_page = [line for line in lines if line["page"] == 1]
    title_lines = [line for line in first_page if line["role"] == "title"]
    title = _join_lines([line["text"] for line in title_lines])
    meta_lines = [line for line in first_page if line["role"] == "meta"]
    authors = next(
        (line["text"] for line in meta_lines if "," in line["text"] and "@" not in line["text"]),
        "",
    )
    abstract_line = next((line for line in first_page if line["role"] == "abstract"), None)
    abstract = ""
    if abstract_line:
        index = lines.index(abstract_line)
        group = [abstract_line]
        for line in lines[index + 1 :]:
            if line["page"] != 1 or line["role"] in ("keywords", "heading", "furniture"):
                break
            if re.match(r"^(?:Citation:|doi:|\s*INTRODUCTION\b)", line["text"], re.I):
                break
            group.append(line)
        abstract = re.sub(
            r"^Abstract\b\s*[:—–-]?\s*",
            "",
            _join_lines([line["text"] for line in group]),
            flags=re.I,
        )
    keywords_line = next((line for line in first_page if line["role"] == "keywords"), None)
    keywords = (
        re.sub(r"^(?:Keywords|Index Terms)\s*[:—–-]\s*", "", keywords_line["text"], flags=re.I)
        if keywords_line
        else ""
    )
    first_text = "\n".join(line["text"] for line in first_page)
    doi_match = DOI_RE.search(first_text)
    arxiv_match = ARXIV_RE.search(first_text)
    license_text = (
        "CC BY 4.0"
        if re.search(r"Creative Commons\s+Attribution.*?CC BY", first_text, re.I | re.S)
        else "unknown"
    )
    digest = hashlib.sha256(pdf_path.read_bytes()).hexdigest()
    return {
        "title": title,
        "authors": authors,
        "abstract": abstract,
        "keywords": keywords,
        "doi": doi_match.group(0) if doi_match else "",
        "arxivId": arxiv_match.group(1) if arxiv_match else "",
        "pageCount": page_count,
        "sha256": digest,
        "license": license_text,
        "sourceFile": str(pdf_path),
    }


def build_brief(blocks: List[Dict[str, Any]], meta: Dict[str, Any]) -> Dict[str, Any]:
    """Build a compact, reusable paper brief for every later question."""
    sections = []
    for index, block in enumerate(blocks):
        if block["type"] != "heading":
            continue
        gist = ""
        for following in blocks[index + 1 :]:
            if following["type"] == "heading":
                break
            if following["type"] == "paragraph":
                gist = clean_text(following.get("text", ""))[:360]
                break
        sections.append(
            {
                "heading": block["text"],
                "page": block.get("page"),
                "gist": gist,
            }
        )
    figures = [
        {
            "label": block.get("label", ""),
            "page": block.get("page"),
            "caption": clean_text(block.get("caption") or block.get("text", ""))[:300],
        }
        for block in blocks
        if block["type"] == "figure"
    ]
    tables = [
        {
            "label": block.get("label", ""),
            "page": block.get("page"),
            "caption": clean_text(block.get("caption") or block.get("text", ""))[:300],
        }
        for block in blocks
        if block["type"] == "table"
    ]
    equations = [
        {
            "label": block.get("label", ""),
            "page": block.get("page"),
            "text": clean_text(block.get("text", ""))[:240],
        }
        for block in blocks
        if block["type"] == "equation"
    ]
    return {
        "title": meta.get("title", ""),
        "authors": meta.get("authors", ""),
        "identifiers": {"doi": meta.get("doi", ""), "arxiv": meta.get("arxivId", "")},
        "abstract": clean_text(meta.get("abstract", ""))[:1400],
        "keywords": meta.get("keywords", ""),
        "sections": sections[:16],
        "figures": figures[:24],
        "tables": tables[:12],
        "equations": equations[:16],
        "referenceCount": sum(1 for block in blocks if block["type"] == "reference"),
        "generatedAt": "",
    }


def build_coverage(
    lines: List[Dict[str, Any]],
    blocks: List[Dict[str, Any]],
    assets: List[Dict[str, Any]],
) -> Dict[str, Any]:
    source_chars = sum(len(line["text"]) for line in lines)
    content_lines = [line for line in lines if line["role"] not in ("furniture", "meta")]
    content_chars = sum(len(line["text"]) for line in content_lines)
    meta_chars = sum(len(line["text"]) for line in lines if line["role"] == "meta")
    furniture_chars = sum(len(line["text"]) for line in lines if line["role"] == "furniture")
    covered_chars = sum(len(block.get("text", "")) for block in blocks)
    assigned_ids = {
        source_id
        for block in blocks
        for source_id in block.get("sourceIds", [])
    }
    assigned_content = [line for line in content_lines if line["id"] in assigned_ids]
    unassigned = [line for line in content_lines if line["id"] not in assigned_ids]
    assigned_chars = sum(len(line["text"]) for line in assigned_content)
    roles: Dict[str, int] = {}
    for line in lines:
        roles[line["role"]] = roles.get(line["role"], 0) + 1
    kinds: Dict[str, int] = {}
    for asset in assets:
        kinds[asset["kind"]] = kinds.get(asset["kind"], 0) + 1
    return {
        "sourceLines": len(lines),
        "sourceCharacters": source_chars,
        "contentCharacters": content_chars,
        "metaCharacters": meta_chars,
        "furnitureCharacters": furniture_chars,
        "mirrorCharacters": covered_chars,
        "characterRatio": round(assigned_chars / content_chars, 4) if content_chars else 0,
        "wholePageRatio": round(assigned_chars / source_chars, 4) if source_chars else 0,
        "assignedLines": len(assigned_content),
        "unassignedLines": [
            {"id": line["id"], "role": line["role"], "page": line["page"], "text": line["text"][:160]}
            for line in unassigned
        ],
        "roles": roles,
        "blockTypes": {
            kind: sum(1 for block in blocks if block["type"] == kind)
            for kind in sorted({block["type"] for block in blocks})
        },
        "assetKinds": kinds,
        "todo": [line["id"] for line in lines if line["role"] in ("prose",)][:0],
    }


def build_mirrordoc(
    pdf_path: Path,
    lines: List[Dict[str, Any]],
    blocks: List[Dict[str, Any]],
    assets: List[Dict[str, Any]],
    meta: Dict[str, Any],
) -> Dict[str, Any]:
    meta = dict(meta)
    meta["brief"] = build_brief(blocks, meta)
    outline = [
        {
            "id": f"b{index:04d}",
            "level": int(block.get("level", 1)),
            "title": block["text"],
            "blockId": f"b{index:04d}",
        }
        for index, block in enumerate(blocks)
        if block["type"] == "heading"
    ]
    for index, block in enumerate(blocks):
        block["id"] = f"b{index:04d}"
    return {
        "schemaVersion": 1,
        "docId": "paper-" + meta["sha256"][:12],
        "meta": meta,
        "version": {
            "kind": "unknown",
            "label": "本地 PDF 导入（版本未核验）",
            "source": "local-pdf",
            "license": meta["license"],
            "fetchedAt": "",
            "sha256": meta["sha256"],
            "riskNote": "PDF 可能是预印本、录用稿或正式版；阅读前请以原版 PDF 核对。",
        },
        "provenance": {
            "input": {"form": "local-pdf", "value": str(pdf_path)},
            "mirrorKind": "pdf",
            "channel": {"route": "pdfplumber-line-blocks", "success": True, "pages": meta["pageCount"]},
        },
        "outline": outline,
        "blocks": blocks,
        "assets": assets,
        "coverage": build_coverage(lines, blocks, assets),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--dpi", type=int, default=200)
    parser.add_argument("--max-pages", type=int, default=None)
    parser.add_argument("--skip-source-pages", action="store_true")
    parser.add_argument("--progress", action="store_true")
    args = parser.parse_args()

    if not args.pdf.is_file():
        print(f"ERROR: PDF not found: {args.pdf}", file=sys.stderr)
        return 2

    args.out.mkdir(parents=True, exist_ok=True)
    lines, page_count, rotated_pages = extract_lines(args.pdf, max_pages=args.max_pages)
    progress(args.progress, "read", f"已读取 {page_count} 页 / {len(lines)} 行")
    annotate_roles(lines)
    progress(args.progress, "classify", "标题、正文与题注已分类")
    assets = detect_assets(args.pdf, lines, min(page_count, args.max_pages or page_count))
    rotated_assets = rotated_table_assets(args.pdf, rotated_pages)
    assets.extend(rotated_assets)
    counts: Dict[str, int] = {}
    for asset in assets:
        counts[asset["kind"]] = counts.get(asset["kind"], 0) + 1
    progress(
        args.progress,
        "assets",
        f"找到 {counts.get('figure', 0)} 图 / {counts.get('table', 0)} 表 / {counts.get('equation', 0)} 公式",
    )
    annotate_table_bodies(lines, assets)
    assign_figure_labels(lines, assets)
    annotate_figure_texts(lines, assets)
    crop_assets(args.pdf, assets, args.out, dpi=args.dpi)
    progress(args.progress, "crop", "图、表、公式已搬出")
    if not args.skip_source_pages:
        render_source_pages(args.pdf, args.out, dpi=110)
        progress(args.progress, "pages", "原版页已备好")
    blocks = build_blocks(lines, assets)
    for asset in rotated_assets:
        blocks.append(
            {
                "type": "table",
                "text": asset["caption"],
                "caption": asset["caption"],
                "tableText": asset.get("text", ""),
                "label": asset["label"],
                "page": asset["page"],
                "bbox": asset["bbox"],
                "asset": asset.get("image", ""),
                "sourceIds": [],
                "rotatedPage": True,
            }
        )
    attach_equation_assets(blocks, assets)
    meta = extract_metadata(lines, args.pdf, page_count)
    progress(args.progress, "mirror", "整理 MirrorDoc")
    doc = build_mirrordoc(args.pdf, lines, blocks, assets, meta)
    doc["coverage"]["rotatedTablePages"] = sorted(rotated_pages)
    doc["coverage"]["rotatedTableAssets"] = len(rotated_assets)

    (args.out / "mirrordoc.json").write_text(
        json.dumps(doc, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (args.out / "lines.json").write_text(
        json.dumps(lines, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (args.out / "assets.json").write_text(
        json.dumps(assets, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    coverage = doc["coverage"]
    report = [
        "# PDF -> MirrorDoc extraction report",
        "",
        f"- source: `{args.pdf}`",
        f"- pages: {meta['pageCount']}",
        f"- title: {meta['title']}",
        f"- DOI: {meta['doi'] or '(not found)'}",
        f"- license: {meta['license']}",
        f"- source lines: {coverage['sourceLines']}",
        f"- blocks: {len(blocks)}",
        f"- rotated table pages: {sorted(rotated_pages) or 'none'}",
        f"- text coverage: {coverage['characterRatio'] * 100:.2f}%",
        f"- whole-page text ratio: {coverage['wholePageRatio'] * 100:.2f}%",
        f"- roles: {json.dumps(coverage['roles'], ensure_ascii=False)}",
        f"- block types: {json.dumps(coverage['blockTypes'], ensure_ascii=False)}",
        f"- asset kinds: {json.dumps(coverage['assetKinds'], ensure_ascii=False)}",
        "",
        "## Notes",
        "",
        "- Text lines are reconstructed from character positions because the source text layer has no spaces.",
        "- Duplicate ligature glyphs are removed before `ﬁ/ﬂ` expansion.",
        "- Figures/tables/equations are cropped from the source page; they are not re-typeset in this prototype.",
        "- Unmatched captions remain visible as `caption` blocks rather than being dropped.",
    ]
    (args.out / "report.md").write_text("\n".join(report) + "\n", encoding="utf-8")
    (args.out / "paper-summary.json").write_text(
        json.dumps(doc["meta"]["brief"], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    progress(args.progress, "done", "抄写完成")
    print(json.dumps({"out": str(args.out), "pages": meta["pageCount"], "blocks": len(blocks), "coverage": coverage}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
