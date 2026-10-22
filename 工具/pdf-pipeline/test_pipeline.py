#!/usr/bin/env python3
"""Unit tests for the PDF -> MirrorDoc prototype's pure logic."""

from __future__ import annotations

import sys
import tempfile
import unittest
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extract_pdf import (  # noqa: E402
    CAPTION_RE,
    _detect_column_split,
    _column_end_for_full_width_artifact,
    _borderless_figure_region,
    _borderless_table_region,
    _borderless_table_region_above,
    _algorithm_steps,
    _equation_regions,
    _group_chars_to_lines,
    _infer_column_structure,
    _infer_column_split,
    _infer_table_structure,
    _table_structure_from_words,
    _is_rotated_page,
    _is_caption_continuation,
    annotate_roles,
    attach_content_rules,
    build_blocks,
    build_coverage,
    build_mirrordoc,
    classify_line,
    clean_text,
    is_reference_entry_start,
    reconstruct_line_text,
)
from reconcile_layout import (  # noqa: E402
    clean_caption,
    cleanup_noise,
    merge_continuations,
    merge_equation_limits,
    normalize_text,
    order_blocks_by_column,
    order_logical_sections,
    split_runin_headings,
    split_supporting,
    text_quality_issues,
)
from ai_order_audit import _extract_json, build_outline  # noqa: E402
from audit_structure import (  # noqa: E402
    build_report,
    detect_reading_order,
    detect_separators,
    detect_unattached_captions,
)
from render_html import render_html  # noqa: E402


def char(text: str, x0: float, x1: float, top: float = 0.0, size: float = 10.0, font: str = "Test-Roma"):
    return {
        "text": text,
        "x0": x0,
        "x1": x1,
        "top": top,
        "bottom": top + size,
        "size": size,
        "fontname": font,
    }


class TextReconstructionTests(unittest.TestCase):
    def test_inserts_space_at_word_gap(self):
        chars = [
            char("A", 0, 5),
            char("B", 5, 10),
            char("C", 10, 15),
            char("D", 18, 23),
            char("E", 23, 28),
        ]
        self.assertEqual(reconstruct_line_text(chars), "ABC DE")

    def test_does_not_insert_space_inside_word(self):
        chars = [char("H", 0, 6), char("i", 6, 8)]
        self.assertEqual(reconstruct_line_text(chars), "Hi")

    def test_duplicate_ligature_glyph_is_removed_before_expansion(self):
        chars = [
            char("d", 0, 5),
            char("e", 5, 10),
            char("ﬁ", 10, 14),
            char("ﬁ", 10, 14),
            char("n", 14, 19),
            char("e", 19, 24),
            char("d", 24, 29),
        ]
        self.assertEqual(reconstruct_line_text(chars), "defined")

    def test_clean_text_expands_ligatures(self):
        self.assertEqual(clean_text("deﬁned ﬂow"), "defined flow")
        self.assertEqual(clean_text("a\u00a0 b"), "a b")
        self.assertEqual(clean_text("a 15(cid:48)(cid:48) laptop"), "a 15″ laptop")

    def test_full_width_heading_merged_with_other_column_is_split(self):
        chars = [
            {
                "text": "4.3 Tweet Analysis Approaches",
                "x0": 36,
                "x1": 184,
                "top": 100,
                "bottom": 110,
                "size": 10,
                "fontname": "Test-Bold",
            },
            {
                "text": "and to explore whether those topics were misused",
                "x0": 292,
                "x1": 530,
                "top": 100,
                "bottom": 110,
                "size": 10,
                "fontname": "Test-Roma",
            },
        ]
        lines = _group_chars_to_lines(chars, 7, "full")
        self.assertEqual([line["text"] for line in lines], [
            "4.3 Tweet Analysis Approaches",
            "and to explore whether those topics were misused",
        ])

    def test_full_width_right_heading_is_split_from_left_body(self):
        chars = [
            {
                "text": "collaboration of the approach could improve diagnosis",
                "x0": 36,
                "x1": 270,
                "top": 100,
                "bottom": 110,
                "size": 10,
                "fontname": "Test-Roma",
            },
            {
                "text": "4.4 Network Analysis Approaches",
                "x0": 292,
                "x1": 500,
                "top": 100,
                "bottom": 110,
                "size": 10,
                "fontname": "Test-Bold",
            },
        ]
        lines = _group_chars_to_lines(chars, 7, "full")
        self.assertEqual(lines[-1]["text"], "4.4 Network Analysis Approaches")

    def test_line_diagnostics_record_center_gap(self):
        chars = [
            char("left column text", 40, 260),
            char("right column text", 300, 520),
        ]
        lines = _group_chars_to_lines(chars, 7, "full", page_width=595.0)
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["maxCenterGap"], 40.0)
        self.assertGreaterEqual(lines[0]["maxInternalGap"], 40.0)

    def test_reading_order_audit_flags_full_width_cross_column_line(self):
        findings, summary = detect_reading_order(
            [
                {
                    "id": "p007-f001",
                    "page": 7,
                    "role": "prose",
                    "columnScope": "full",
                    "text": "left column prose that continues into the right column prose",
                    "x0": 40,
                    "top": 200,
                    "x1": 540,
                    "bottom": 210,
                    "pageWidth": 595,
                    "columnSplit": 300,
                    "maxCenterGap": 60,
                }
            ]
        )
        self.assertEqual([item["rule"] for item in findings], ["reading-order.cross-column-line"])
        self.assertEqual(summary["crossColumnLines"], 1)

    def test_reading_order_audit_ignores_single_column_table_row(self):
        findings, summary = detect_reading_order(
            [
                {
                    "id": "p021-f003",
                    "page": 21,
                    "role": "prose",
                    "columnScope": "full",
                    "text": "WDC Web Tables Corpus TQA, SP It contains table and metadata",
                    "x0": 93,
                    "top": 99,
                    "x1": 535,
                    "bottom": 108,
                    "pageWidth": 612,
                    "columnSplit": None,
                    "maxCenterGap": 70,
                }
            ]
        )
        self.assertEqual(findings, [])
        self.assertEqual(summary["crossColumnLines"], 0)

    def test_separator_audit_flags_unrepresented_content_rule(self):
        rules = [
            {
                "id": "p010-hr001",
                "page": 10,
                "x0": 40,
                "top": 265,
                "x1": 500,
                "bottom": 265,
            }
        ]
        findings, summary = detect_separators([], rules)
        self.assertEqual([item["rule"] for item in findings], ["separator.unrepresented"])
        self.assertEqual(summary["unrepresented"], 1)

    def test_separator_audit_accepts_block_and_visual_rule_slots(self):
        rules = [
            {"id": "p010-hr001", "page": 10},
            {"id": "p010-hr002", "page": 10},
        ]
        blocks = [
            {"type": "separator", "ruleId": "p010-hr001"},
            {"type": "algorithm", "visualRules": [{"ruleId": "p010-hr002"}]},
        ]
        findings, summary = detect_separators(blocks, rules)
        self.assertEqual(findings, [])
        self.assertEqual(summary["represented"], 2)


class ClassificationTests(unittest.TestCase):
    def line(self, text: str, **overrides):
        value = {
            "page": 1,
            "text": text,
            "top": 300.0,
            "bottom": 310.0,
            "size": 10.0,
            "bold": False,
            "columnScope": "right",
            "page_height": 842.0,
        }
        value.update(overrides)
        return value

    def test_numbered_heading_with_trailing_dot(self):
        self.assertEqual(classify_line(self.line("1. Introduction"), 10.0), "heading")
        self.assertEqual(classify_line(self.line("2.1. Experimental Setup"), 10.0), "heading")

    def test_caption_requires_punctuation(self):
        self.assertEqual(classify_line(self.line("Figure 1. The prototype."), 10.0), "caption")
        self.assertEqual(classify_line(self.line("Figure 3a shows the prototype."), 10.0), "prose")

    def test_caption_accepts_reconstruction_dots(self):
        self.assertIsNotNone(CAPTION_RE.match(". . . Table 1. Characteristics of Eligible Trials."))
        self.assertEqual(classify_line(self.line(". . . Table 1. Characteristics.", role=None), 10.0), "caption")

    def test_bare_table_label_is_a_caption(self):
        self.assertEqual(classify_line(self.line("TABLE 7", top=270), 10.0), "caption")
        self.assertEqual(classify_line(self.line("Table 9 shows the results", top=270), 10.0), "prose")

    def test_structured_abstract_and_all_caps_headings(self):
        self.assertEqual(classify_line(self.line("Background. Sharing data.", top=160), 9.0), "abstract")
        self.assertEqual(classify_line(self.line("INTRODUCTION", size=11.0), 9.0), "heading")
        self.assertEqual(classify_line(self.line("DOC)", size=11.0), 9.0), "prose")

    def test_standalone_abstract_title_is_structural(self):
        self.assertEqual(
            classify_line(self.line("Abstract", top=250, bold=True), 10.0),
            "abstract",
        )

    def test_abstract_and_index_terms_with_dash_are_structural(self):
        self.assertEqual(
            classify_line(self.line("Abstract— This paper studies the problem.", top=160), 10.0),
            "abstract",
        )
        self.assertEqual(
            classify_line(self.line("Index Terms— Spam, Twitter, machine learning", top=300), 10.0),
            "keywords",
        )

    def test_algorithm_sentinels_are_not_headings(self):
        self.assertEqual(
            classify_line(self.line("BEGIN", top=318, bold=True), 10.0),
            "prose",
        )
        self.assertEqual(
            classify_line(self.line("END", top=500, bold=True), 10.0),
            "prose",
        )

    def test_reconstruction_dot_noise_is_furniture(self):
        self.assertEqual(
            classify_line(self.line("........................", top=500), 10.0),
            "furniture",
        )

    def test_numbered_sentence_is_not_a_heading(self):
        self.assertEqual(
            classify_line(
                self.line("2. There are 3 data streams hosted by three nodes", top=300),
                10.0,
            ),
            "prose",
        )
        self.assertEqual(
            classify_line(
                self.line("8. Additionally, Table 1 depicts frequently used abbreviations", top=300),
                10.0,
            ),
            "prose",
        )

    def test_wrapped_numbered_heading_is_rejoined(self):
        lines = [
            self.line("5.2 Research Objectives, Techniques, and", top=360, bottom=370, size=10, bold=True),
            self.line("Evaluation Parameters", top=371, bottom=381, size=10, bold=True),
            self.line("The results answer the questions.", top=392, bottom=401.5, size=9.5),
        ]
        annotate_roles(lines)
        self.assertEqual(lines[0]["role"], "heading")
        self.assertEqual(lines[1]["role"], "heading_continuation")

    def test_generic_page_varying_running_head_is_furniture(self):
        lines = [
            self.line(
                "AgriEngineering 2026, 8, 11 2 of 19",
                page=2,
                top=36,
                bottom=46,
                size=8,
                columnScope="full",
            ),
            self.line(
                "AgriEngineering 2026, 8, 11 3 of 19",
                page=3,
                top=36,
                bottom=46,
                size=8,
                columnScope="full",
            ),
            self.line(
                "AgriEngineering 2026, 8, 11 4 of 19",
                page=4,
                top=36,
                bottom=46,
                size=8,
                columnScope="full",
            ),
            self.line(
                "5.1. Plant Disease Detection Results",
                page=5,
                top=74,
                bottom=84,
                size=10,
                columnScope="full",
            ),
        ]
        annotate_roles(lines)
        self.assertEqual([line["role"] for line in lines[:3]], ["furniture"] * 3)
        self.assertEqual(lines[3]["role"], "heading")

    def test_reference_entry_is_not_a_heading_after_references_start(self):
        lines = [
            self.line("References", page=20, bold=True),
            self.line("1. Rushton, A.; Croucher, P. The Handbook of Logistics.", page=20),
            self.line("24. Kun, G.; Xi, W. Design and Analysis.", page=21),
        ]
        annotate_roles(lines)
        self.assertEqual(lines[0]["role"], "references_heading")
        self.assertEqual(lines[1]["role"], "prose")
        self.assertEqual(lines[2]["role"], "prose")

    def test_first_page_metadata_does_not_swallow_abstract_in_other_column(self):
        lines = [
            self.line("A Paper", page=1, role=None, top=100, size=18, bold=True),
            self.line("A. Author", page=1, top=150, columnScope="full"),
            self.line("Abstract: This paper studies damage.", page=1, top=250, columnScope="right"),
            self.line("1. Introduction", page=1, top=300, columnScope="right", size=11, bold=True),
            self.line("The body begins here.", page=1, top=320, columnScope="right"),
            self.line("Academic Editor: Someone", page=1, top=500, columnScope="left"),
            self.line("Copyright: authors.", page=1, top=540, columnScope="left"),
        ]
        annotate_roles(lines)
        self.assertEqual(lines[2]["role"], "abstract")
        self.assertEqual(lines[4]["role"], "prose")
        self.assertEqual(lines[5]["role"], "meta")
        self.assertEqual(lines[6]["role"], "meta")

    def test_equation_limit_line_is_part_of_display_equation(self):
        lines = [
            self.line("Mp = max M(t). (2)", page=6, top=700, bottom=710, x0=350, x1=520),
            self.line("t∈[t1,t2]", page=6, top=716, bottom=724, x0=350, x1=380),
            self.line("The next paragraph begins here.", page=6, top=740, bottom=750, x0=350, x1=520),
        ]
        annotate_roles(lines)
        self.assertEqual(lines[0]["role"], "equation")
        self.assertEqual(lines[1]["role"], "equation")
        self.assertEqual(lines[2]["role"], "prose")
        regions = _equation_regions(lines)
        self.assertEqual(len(regions), 1)
        self.assertLessEqual(regions[0]["bbox"][3], 731)

    def test_caption_continuation_accepts_lowercase_but_not_table_body(self):
        caption = {
            "page": 6,
            "role": "caption",
            "text": "Figure 15. Measurements",
            "x0": 166.0,
            "top": 300.0,
            "bottom": 309.0,
            "size": 9.0,
        }
        lower = {
            "page": 6,
            "role": "prose",
            "text": "tude waveform measured inside the package.",
            "x0": 166.0,
            "top": 311.0,
            "bottom": 320.0,
            "size": 9.0,
        }
        upper = {
            "page": 6,
            "role": "prose",
            "text": "Estimated Operation Time [Days]",
            "x0": 166.0,
            "top": 311.0,
            "bottom": 320.0,
            "size": 9.0,
        }
        self.assertTrue(_is_caption_continuation(caption, lower))
        self.assertFalse(_is_caption_continuation(caption, upper))

    def test_caption_continuation_accepts_tight_uppercase_sentence(self):
        caption = {
            "page": 2,
            "role": "caption",
            "text": "Figure 1. Circular representation.",
            "x0": 58.0,
            "top": 671.0,
            "bottom": 679.0,
            "size": 8.0,
        }
        tail = {
            "page": 2,
            "role": "prose",
            "text": "Antimicrobial determinants are colored red and labelled with gene names as follows: sul1, floR, tetRA.",
            "x0": 58.0,
            "top": 680.0,
            "bottom": 688.0,
            "size": 8.0,
        }
        self.assertTrue(_is_caption_continuation(caption, tail))

    def test_caption_continuation_accepts_acronym_after_existing_hyphen(self):
        caption = {
            "page": 12,
            "role": "caption",
            "text": "Table 3. Classification report (MobileViT-",
            "x0": 166.0,
            "top": 74.0,
            "bottom": 83.0,
            "size": 9.0,
        }
        tail = {
            "page": 12,
            "role": "prose",
            "text": "XXSmall).",
            "x0": 166.0,
            "top": 87.0,
            "bottom": 96.0,
            "size": 9.0,
        }
        self.assertTrue(_is_caption_continuation(caption, tail))

    def test_full_width_bare_table_label_accepts_centered_subtitle(self):
        caption = {
            "page": 4,
            "role": "caption",
            "text": "TABLE 2",
            "x0": 260,
            "top": 60,
            "bottom": 70,
            "size": 9.5,
            "columnScope": "full",
        }
        subtitle = {
            "page": 4,
            "role": "prose",
            "text": "SUMMARY OF THE RELATED WORKS",
            "x0": 210,
            "top": 72,
            "bottom": 81,
            "size": 7.5,
            "columnScope": "full",
        }
        self.assertTrue(_is_caption_continuation(caption, subtitle))


class ColumnDetectionTests(unittest.TestCase):
    def test_full_page_sideways_text_is_marked_rotated(self):
        class FakePage:
            chars = [
                {"text": "A", "upright": False},
                {"text": "B", "upright": False},
                {"text": "C", "upright": False},
                {"text": "D", "upright": True},
            ]

        self.assertTrue(_is_rotated_page(FakePage()))

    def test_landscape_page_with_quarter_turn_is_marked_rotated(self):
        class FakePage:
            width = 842
            height = 595
            rotation = 90
            chars = [{"text": "A", "upright": True}]

        self.assertTrue(_is_rotated_page(FakePage()))

    def test_finds_gap_between_two_columns(self):
        class FakePage:
            width = 600
            height = 842
            chars = []

        page = FakePage()
        for y in range(100, 760, 4):
            page.chars.append(char("L", 60, 250, top=y, size=9))
            page.chars.append(char("R", 320, 540, top=y, size=9))
        split = _detect_column_split(page, 60.0)
        self.assertIsNotNone(split)
        self.assertTrue(250 < split < 320)

    def test_infers_columns_from_word_starts_when_gap_is_occupied(self):
        class FakePage:
            width = 600
            height = 842

            def extract_words(self):
                words = []
                for y in range(100, 700, 10):
                    words.append({"x0": 60, "x1": 250, "top": y, "bottom": y + 8})
                    words.append({"x0": 320, "x1": 540, "top": y, "bottom": y + 8})
                return words

        self.assertEqual(_infer_column_split(FakePage()), 314)
        self.assertEqual(
            _infer_column_structure(FakePage()),
            {"split": 314.0, "top": 100.0},
        )

    def test_does_not_split_full_width_reference_lines_at_page_midpoint(self):
        class FakePage:
            width = 600
            height = 842

            def extract_words(self):
                words = [{"x0": 40, "x1": 280, "top": y, "bottom": y + 8} for y in range(100, 700, 10)]
                # Right-half words exist, but their starts are spread through
                # the line, not anchored to a second column gutter.
                for index, y in enumerate(range(100, 700, 10)):
                    words.append({"x0": 330 + (index % 8) * 25, "x1": 560, "top": y, "bottom": y + 8})
                return words

        self.assertIsNone(_infer_column_split(FakePage()))

    def test_column_buckets_stop_at_large_lower_page_figure(self):
        clusters = [
            {"bbox": [55, 237, 556, 661], "top": 237, "bottom": 661},
            {"bbox": [60, 300, 180, 400], "top": 300, "bottom": 400},
        ]
        self.assertEqual(_column_end_for_full_width_artifact(clusters, 842, 612, 45), 229)
        self.assertIsNone(_column_end_for_full_width_artifact(clusters, 842, 612, 240))

    def test_borderless_table_region_uses_dense_rows_until_body_text(self):
        caption = {
            "page": 2,
            "columnScope": "full",
            "bbox": [150, 70, 450, 80],
            "top": 70,
            "bottom": 80,
        }
        lines = [
            {"id": "title", "page": 2, "role": "prose", "text": "REVIEW TABLE", "x0": 170, "x1": 420, "top": 81, "bottom": 90, "size": 7.5, "columnScope": "full"},
            {"id": "head", "page": 2, "role": "prose", "text": "Ref Main ideas Merits", "x0": 40, "x1": 540, "top": 95, "bottom": 100, "size": 6, "columnScope": "full"},
            {"id": "row", "page": 2, "role": "prose", "text": "[1] Detecting spam High accuracy", "x0": 40, "x1": 530, "top": 110, "bottom": 116, "size": 6, "columnScope": "full"},
            {"id": "body", "page": 2, "role": "prose", "text": "This paragraph returns to ordinary body text.", "x0": 40, "x1": 540, "top": 130, "bottom": 140, "size": 10, "columnScope": "full"},
        ]
        region = _borderless_table_region(lines, caption, 10.0, 600, 842)
        self.assertIsNotNone(region)

    def test_borderless_table_region_can_end_at_caption_below_table(self):
        caption = {
            "page": 17,
            "columnScope": "full",
            "bbox": [200, 232, 410, 242],
            "top": 232,
            "bottom": 242,
        }
        lines = [
            {"id": "header", "page": 17, "columnScope": "full", "role": "prose", "text": "Task Task Coverage Examples", "x0": 90, "x1": 520, "top": 189, "bottom": 197, "size": 9, "maxCenterGap": 30},
            {"id": "row1", "page": 17, "columnScope": "full", "role": "prose", "text": "Classification labels examples", "x0": 90, "x1": 520, "top": 203, "bottom": 211, "size": 9, "maxCenterGap": 30},
            {"id": "row2", "page": 17, "columnScope": "full", "role": "prose", "text": "Regression predicts values", "x0": 90, "x1": 520, "top": 212, "bottom": 220, "size": 9, "maxCenterGap": 30},
            {"id": "caption", "page": 17, "columnScope": "full", "role": "caption", "text": "Table 1: Tasks", "x0": 200, "x1": 410, "top": 321, "bottom": 331, "size": 10},
        ]
        region = _borderless_table_region_above(lines, caption, 10.0, 612.0)
        self.assertIsNotNone(region)
        self.assertLess(region[1], 189)
        self.assertGreaterEqual(region[3], 230)

    def test_table_structure_recovers_rows_and_columns_from_words(self):
        words = [
            {"text": "Task", "x0": 90, "x1": 120, "top": 100, "bottom": 108},
            {"text": "Coverage", "x0": 190, "x1": 240, "top": 100, "bottom": 108},
            {"text": "Examples", "x0": 450, "x1": 520, "top": 100, "bottom": 108},
            {"text": "Classification", "x0": 90, "x1": 140, "top": 110, "bottom": 118},
            {"text": "labels", "x0": 190, "x1": 240, "top": 110, "bottom": 118},
            {"text": "[52]", "x0": 450, "x1": 470, "top": 110, "bottom": 118},
            {"text": "Regression", "x0": 90, "x1": 135, "top": 120, "bottom": 128},
            {"text": "values", "x0": 190, "x1": 225, "top": 120, "bottom": 128},
            {"text": "[21]", "x0": 450, "x1": 470, "top": 120, "bottom": 128},
        ]
        structure = _table_structure_from_words(words, (80, 98, 530, 130))
        self.assertEqual(structure["rowCount"], 3)
        self.assertEqual(structure["columnCount"], 3)
        self.assertEqual(structure["rows"][1]["cells"], ["Classification", "labels", "[52]"])

    def test_table_structure_prefers_pdfplumber_grid(self):
        class FakeTable:
            bbox = (80, 100, 520, 140)

            def extract(self):
                return [
                    ["Dataset", "Task", "Modality"],
                    ["WikiTQ", "QA", "Semi-structured"],
                    ["SPIDER", "SQL", "Text"],
                ]

        class FakePage:
            def find_tables(self):
                return [FakeTable()]

            def extract_words(self):
                raise AssertionError("word fallback should not run")

        structure = _infer_table_structure(FakePage(), (70, 90, 530, 150))
        self.assertEqual(structure["mode"], "line-grid")
        self.assertEqual(structure["rowCount"], 3)
        self.assertEqual(structure["columnCount"], 3)

    def test_table_structure_uses_header_columns_for_merged_first_column(self):
        words = [
            {"text": "Fragility", "x0": 55, "x1": 100, "top": 100, "bottom": 108},
            {"text": "Product", "x0": 280, "x1": 330, "top": 100, "bottom": 108},
            {"text": "Level", "x0": 500, "x1": 530, "top": 100, "bottom": 108},
            {"text": "VeryDelicate", "x0": 60, "x1": 120, "top": 120, "bottom": 128},
            {"text": "equipment description", "x0": 190, "x1": 320, "top": 120, "bottom": 128},
            {"text": "25-40g", "x0": 500, "x1": 530, "top": 120, "bottom": 128},
            {"text": "ModeratelyRugged", "x0": 55, "x1": 125, "top": 140, "bottom": 148},
            {"text": "machinery", "x0": 268, "x1": 310, "top": 140, "bottom": 148},
            {"text": ">=115g", "x0": 503, "x1": 530, "top": 140, "bottom": 148},
        ]
        structure = _table_structure_from_words(words, (50, 98, 540, 150))
        self.assertEqual(structure["columnCount"], 3)
        self.assertEqual(structure["rows"][1]["cells"][0], "VeryDelicate")

    def test_table_structure_marks_vertical_merge_in_first_column(self):
        words = [
            {"text": "Task", "x0": 55, "x1": 90, "top": 100, "bottom": 108},
            {"text": "Method", "x0": 280, "x1": 330, "top": 100, "bottom": 108},
            {"text": "SemanticParsing", "x0": 55, "x1": 130, "top": 120, "bottom": 128},
            {"text": "First", "x0": 280, "x1": 330, "top": 120, "bottom": 128},
            {"text": "Second", "x0": 280, "x1": 330, "top": 140, "bottom": 148},
        ]
        structure = _table_structure_from_words(words, (50, 98, 340, 150))
        merged = next(
            row for row in structure["rows"]
            if row["cells"] and row["cells"][0] == "SemanticParsing"
        )
        self.assertEqual(merged["rowSpan"][0], 2)
        self.assertEqual(structure["mergedCells"], 1)

    def test_borderless_vector_figure_uses_small_text_above_caption(self):
        caption = {
            "page": 2,
            "columnScope": "right",
            "bbox": [300, 150, 500, 160],
            "top": 150,
            "bottom": 160,
        }
        lines = [
            {"id": "a", "page": 2, "role": "prose", "text": "root", "x0": 340, "x1": 360, "top": 100, "bottom": 106, "size": 7, "columnScope": "right"},
            {"id": "b", "page": 2, "role": "prose", "text": "left pointer right", "x0": 320, "x1": 430, "top": 120, "bottom": 126, "size": 7, "columnScope": "right"},
            {"id": "body", "page": 2, "role": "prose", "text": "Normal body prose before the figure starts here.", "x0": 300, "x1": 530, "top": 70, "bottom": 80, "size": 10, "columnScope": "right"},
        ]
        region = _borderless_figure_region(lines, caption, 10, 600)
        self.assertIsNotNone(region)
        self.assertGreater(region[2] - region[0], 100)
        self.assertLess(region[3], 150)


class CoverageTests(unittest.TestCase):
    def test_assigned_content_lines_cover_all_non_furniture_text(self):
        lines = [
            {"id": "p001-a", "page": 1, "role": "prose", "text": "body"},
            {"id": "p001-b", "page": 1, "role": "furniture", "text": "header"},
            {"id": "p001-c", "page": 1, "role": "meta", "text": "citation"},
        ]
        blocks = [{"type": "paragraph", "text": "body", "sourceIds": ["p001-a"]}]
        coverage = build_coverage(lines, blocks, [])
        self.assertEqual(coverage["characterRatio"], 1.0)
        self.assertEqual(coverage["assignedLines"], 1)
        self.assertEqual(coverage["unassignedLines"], [])

    def test_unassigned_line_is_reported(self):
        lines = [{"id": "p001-a", "page": 1, "role": "prose", "text": "body"}]
        coverage = build_coverage(lines, [], [])
        self.assertEqual(coverage["characterRatio"], 0.0)
        self.assertEqual(coverage["unassignedLines"][0]["id"], "p001-a")


class MirrorDocTests(unittest.TestCase):
    def test_indented_first_line_starts_a_new_prose_paragraph(self):
        def prose(text, x0, top, ident):
            return {
                "id": ident,
                "page": 1,
                "role": "prose",
                "text": text,
                "columnScope": "full",
                "x0": x0,
                "x1": 300,
                "top": top,
                "bottom": top + 9,
                "size": 9.0,
            }

        lines = [
            prose("First paragraph wrapped", 60, 100, "a"),
            prose("line two of first paragraph.", 60, 110, "b"),
            prose("Second paragraph begins here", 69, 120, "c"),
            prose("and continues on the next line.", 60, 130, "d"),
        ]
        blocks = build_blocks(lines, [])
        self.assertEqual([block["type"] for block in blocks], ["paragraph", "paragraph"])
        self.assertTrue(blocks[1]["text"].startswith("Second paragraph"))

    def test_schema_and_outline(self):
        lines = [{"id": "p001-a", "page": 1, "role": "prose", "text": "body"}]
        blocks = [
            {"type": "title", "text": "T", "page": 1, "bbox": [0, 0, 1, 1], "sourceIds": ["p001-a"]},
            {"type": "heading", "text": "1. Introduction", "level": 1, "page": 1, "bbox": [0, 0, 1, 1], "sourceIds": ["p001-a"]},
        ]
        meta = {
            "title": "T",
            "authors": "",
            "abstract": "",
            "keywords": "",
            "doi": "",
            "pageCount": 1,
            "sha256": "a" * 64,
            "license": "unknown",
            "sourceFile": "x.pdf",
        }
        doc = build_mirrordoc(Path("x.pdf"), lines, blocks, [], meta)
        self.assertEqual(doc["schemaVersion"], 1)
        self.assertTrue(doc["docId"].startswith("paper-"))
        self.assertEqual(doc["version"]["kind"], "unknown")
        self.assertEqual(doc["outline"][0]["title"], "1. Introduction")

    def test_algorithm_caption_and_steps_stay_one_structured_block(self):
        def line(ident, text, top, role, bold=False):
            return {
                "id": ident,
                "page": 10,
                "role": role,
                "text": text,
                "columnScope": "full",
                "x0": 172.0,
                "x1": 520.0,
                "top": top,
                "bottom": top + 10,
                "size": 10.0,
                "bold": bold,
            }

        lines = [
            line("caption", "Algorithm 1. IoT control loop.", 270, "caption", True),
            line("begin", "BEGIN", 318, "prose", True),
            line("step1", "1: Initialize sensors and actuators", 332, "prose", True),
            line("step2", "2: WHILE TRUE DO", 346, "prose", True),
            line("step3", "3: Upload sensor data to Firebase", 360, "prose", True),
            line("endwhile", "4: END WHILE", 374, "prose", True),
            line("end", "END", 388, "prose", True),
        ]
        blocks = build_blocks(lines, [])
        self.assertEqual([block["type"] for block in blocks], ["algorithm"])
        algorithm = blocks[0]
        self.assertEqual(algorithm["label"], "Algorithm 1")
        self.assertEqual([step["number"] for step in algorithm["steps"]], [1, 2, 3, 4])
        self.assertEqual([step["depth"] for step in algorithm["steps"]], [0, 0, 1, 0])
        self.assertIn("\n", algorithm["algorithmText"])
        self.assertNotIn("BEGIN", algorithm["algorithmText"])
        self.assertEqual(algorithm["sourceIds"], [item["id"] for item in lines])

    def test_citation_link_tail_does_not_start_a_new_reference(self):
        def line(ident, text, top, role):
            return {
                "id": ident,
                "page": 18,
                "role": role,
                "text": text,
                "columnScope": "full",
                "x0": 60,
                "x1": 550,
                "top": top,
                "bottom": top + 10,
                "size": 9,
                "bold": False,
            }

        lines = [
            line("refs", "References", 70, "references_heading"),
            line("r5", "5. Demilie, W.B. Plant disease detection,", 90, "prose"),
            line("link", "5. [CrossRef]", 103, "prose"),
            line("r6", "6. Awaisi, K.S. A Survey.", 116, "prose"),
        ]
        blocks = build_blocks(lines, [])
        references = [block for block in blocks if block["type"] == "reference"]
        self.assertEqual(len(references), 2)
        self.assertIn("[CrossRef]", references[0]["text"])

    def test_input_while_algorithm_without_begin_end_is_collected(self):
        def line(ident, text, top, size=8.0):
            return {
                "id": ident,
                "page": 4,
                "role": "caption" if ident == "caption" else "prose",
                "text": text,
                "columnScope": "left",
                "x0": 30,
                "x1": 270,
                "top": top,
                "bottom": top + size,
                "size": size,
                "bold": ident == "caption",
            }

        lines = [
            line("caption", "Algorithm 1. Lookup", 100, 8),
            line("input", "Input: query q", 110, 8),
            line("while", "While r is not null do", 120, 9),
            line("read", "Read the next child", 130, 9),
            line("end", "Endwhile", 140, 9),
            line("narrative", "For example, the query traverses two nodes.", 150, 10),
        ]
        blocks = build_blocks(lines, [])
        self.assertEqual([block["type"] for block in blocks], ["algorithm", "paragraph"])
        self.assertEqual(len(blocks[0]["steps"]), 4)
        self.assertEqual([step["depth"] for step in blocks[0]["steps"]], [0, 0, 1, 0])

    def test_algorithm_else_aligns_with_if_and_body_nests(self):
        def step(ident, text, top):
            return {
                "id": ident,
                "page": 1,
                "text": text,
                "x0": 30,
                "top": top,
                "bottom": top + 10,
                "size": 9,
            }

        steps = _algorithm_steps([
            step("if", "If condition then", 0),
            step("then", "Do work", 10),
            step("else", "Else", 20),
            step("other", "Do other work", 30),
            step("end", "Endif", 40),
        ])
        self.assertEqual([item["depth"] for item in steps], [0, 1, 0, 1, 0])

    def test_bibliography_year_is_not_a_reference_start(self):
        self.assertTrue(is_reference_entry_start("21. A. Author. Paper title."))
        self.assertFalse(is_reference_entry_start("2015. His research interests include networks."))

    def test_standalone_html_renders_algorithm_steps(self):
        doc = {
            "meta": {"title": "T", "pageCount": 1},
            "version": {},
            "coverage": {},
            "outline": [],
            "blocks": [{
                "id": "b0000",
                "type": "algorithm",
                "page": 1,
                "label": "Algorithm 1",
                "caption": "Algorithm 1. Control loop.",
                "text": "Algorithm 1. Control loop.",
                "algorithmText": "1: Start\n2: Stop",
            }],
        }
        html = render_html(doc)
        self.assertIn('class="algorithm"', html)
        self.assertIn("1: Start", html)
        self.assertNotIn("Algorithm 1</span>Algorithm 1.", html)

    def test_standalone_html_renders_separator_and_algorithm_rule(self):
        doc = {
            "meta": {"title": "T", "pageCount": 1},
            "version": {},
            "coverage": {},
            "outline": [],
            "blocks": [
                {
                    "id": "b0000",
                    "type": "separator",
                    "page": 1,
                    "text": "",
                    "ruleId": "p001-hr001",
                },
                {
                    "id": "b0001",
                    "type": "algorithm",
                    "page": 1,
                    "label": "Algorithm 1",
                    "caption": "Algorithm 1. Control loop.",
                    "text": "Algorithm 1. Control loop.",
                    "algorithmText": "1: Start",
                    "visualRules": [{"ruleId": "p001-hr002"}],
                },
            ],
        }
        html = render_html(doc)
        self.assertIn('class="separator"', html)
        self.assertIn('class="algorithm-rule"', html)

    def test_standalone_html_renders_table_structure_meta(self):
        doc = {
            "meta": {"title": "T", "pageCount": 1},
            "version": {},
            "coverage": {},
            "outline": [],
            "blocks": [{
                "id": "b0000",
                "type": "table",
                "page": 2,
                "label": "Table 6",
                "caption": "Table 6. Results.",
                "text": "Table 6. Results.",
                "tableStructure": {"rowCount": 19, "columnCount": 10},
                "continuation": True,
                "continuationOfPage": 1,
            }],
        }
        html = render_html(doc)
        self.assertIn("结构识别：19 行 × 10 列", html)
        self.assertIn("续表，承接 p.1", html)


class ReconcileTests(unittest.TestCase):
    def test_normalize_text_collapses_pdf_whitespace(self):
        self.assertEqual(normalize_text("  one\t two\u00a0\nthree  "), "one two three")
        self.assertEqual(normalize_text("a\n\n\nb", keep_newlines=True), "a\n\nb")

    def test_runin_heading_is_recovered_from_larger_first_line(self):
        lines = [
            {"id": "h", "text": "Author Contributions", "size": 10.5, "x0": 1, "top": 1, "x1": 2, "bottom": 2},
            {"id": "p", "text": "Conceived and designed the experiments: HP.", "size": 8.0, "x0": 1, "top": 3, "x1": 2, "bottom": 4},
        ]
        blocks = [{
            "type": "paragraph",
            "text": "Author Contributions Conceived and designed the experiments: HP.",
            "section": "ACKNOWLEDGMENTS",
            "sourceIds": ["h", "p"],
        }]
        out, splits = split_runin_headings(blocks, lines)
        self.assertEqual(splits, 1)
        self.assertEqual([block["type"] for block in out], ["heading", "paragraph"])
        self.assertEqual(out[0]["text"], "Author Contributions")
        self.assertEqual(out[1]["text"], "Conceived and designed the experiments: HP.")

    def test_single_source_paragraph_is_never_promoted_before_next_heading(self):
        lines = [
            {"id": "p", "text": "Accordingly, the result continues", "size": 10.0, "x0": 1, "top": 1, "x1": 2, "bottom": 2},
            {"id": "h", "text": "2. Results", "size": 12.0, "x0": 1, "top": 3, "x1": 2, "bottom": 4},
        ]
        blocks = [
            {"type": "paragraph", "text": "Accordingly, the result continues", "sourceIds": ["p"]},
            {"type": "heading", "text": "2. Results", "sourceIds": ["h"]},
        ]
        out, splits = split_runin_headings(blocks, lines)
        self.assertEqual(splits, 0)
        self.assertEqual([block["type"] for block in out], ["paragraph", "heading"])


    def test_paragraph_continuation_is_merged_without_fake_gap(self):
        blocks = [
            {"type": "paragraph", "section": "RESULTS", "text": "The association remained significant in this", "sourceIds": ["a"]},
            {"type": "paragraph", "section": "RESULTS", "text": "lower-profile subset of trials.", "sourceIds": ["b"]},
            {"type": "paragraph", "section": "RESULTS", "text": "A new paragraph starts here.", "sourceIds": ["c"]},
        ]
        out, merged = merge_continuations(blocks)
        self.assertEqual(merged, 1)
        self.assertEqual(out[0]["text"], "The association remained significant in this lower-profile subset of trials.")
        self.assertEqual(len(out), 2)

    def test_paragraph_continuation_removes_end_of_line_hyphen(self):
        blocks = [
            {"type": "paragraph", "section": "RESULTS", "text": "The model is driv-", "sourceIds": ["a"]},
            {"type": "paragraph", "section": "RESULTS", "text": "ing better results.", "sourceIds": ["b"]},
        ]
        out, merged = merge_continuations(blocks, {"driving"})
        self.assertEqual(merged, 1)
        self.assertEqual(out[0]["text"], "The model is driving better results.")

    def test_paragraph_continuation_preserves_lexical_compound_hyphen(self):
        blocks = [
            {"type": "paragraph", "section": "RESULTS", "text": "It works for domain-", "sourceIds": ["a"]},
            {"type": "paragraph", "section": "RESULTS", "text": "specific applications.", "sourceIds": ["b"]},
        ]
        out, merged = merge_continuations(blocks, {"domain-specific"})
        self.assertEqual(merged, 1)
        self.assertEqual(out[0]["text"], "It works for domain-specific applications.")

    def test_logical_order_puts_all_references_before_acknowledgments(self):
        blocks = [
            {"type": "paragraph", "text": "body", "section": "METHODS"},
            {"type": "reference", "text": "4. Last physical-column reference."},
            {"type": "heading", "text": "SUPPORTING INFORMATION", "level": 1},
            {"type": "heading", "text": "Text S1", "level": 4},
            {"type": "paragraph", "text": "Support one."},
            {"type": "heading", "text": "REFERENCES", "level": 1},
            {"type": "reference", "text": "1. First."},
            {"type": "reference", "text": "2. Second."},
            {"type": "heading", "text": "ACKNOWLEDGMENTS", "level": 1},
            {"type": "paragraph", "text": "Author Contributions Thanks."},
            {"type": "reference", "text": "3. Third."},
            {"type": "heading", "text": "Data S1", "level": 4},
            {"type": "paragraph", "text": "Support data."},
        ]
        out, audit = order_logical_sections(blocks)
        texts = [block["text"] for block in out]
        self.assertTrue(audit["applied"])
        self.assertLess(texts.index("Support one."), texts.index("REFERENCES"))
        self.assertLess(texts.index("Support data."), texts.index("REFERENCES"))
        self.assertEqual(
            [text for text in texts if text.startswith(("1.", "2.", "3.", "4."))],
            ["1. First.", "2. Second.", "3. Third.", "4. Last physical-column reference."],
        )
        self.assertLess(texts.index("3. Third."), texts.index("ACKNOWLEDGMENTS"))
        self.assertEqual(audit["missing"], [])

    def test_ai_order_outline_is_compact_and_keeps_sections(self):
        doc = {
            "meta": {"title": "A Paper", "authors": "A. Author", "doi": "10.1/x"},
            "blocks": [
                {"type": "heading", "text": "INTRODUCTION", "page": 1},
                {"type": "paragraph", "text": "First body paragraph."},
                {"type": "paragraph", "text": "Second body paragraph."},
                {"type": "paragraph", "text": "Third body paragraph omitted."},
                {"type": "heading", "text": "REFERENCES", "page": 5},
                {"type": "reference", "text": "1. One."},
                {"type": "reference", "text": "2. Two."},
                {"type": "heading", "text": "ACKNOWLEDGMENTS", "page": 5},
            ],
        }
        outline = build_outline(doc)
        self.assertIn("[SECTION 1] [H1] INTRODUCTION", outline)
        self.assertIn("First body paragraph.", outline)
        self.assertNotIn("Third body paragraph", outline)
        self.assertIn("REFERENCE SUMMARY: 2 entries; first=1, last=2", outline)

    def test_ai_order_report_accepts_fenced_json(self):
        report = _extract_json('```json\n{"ok": false, "issues": [{"severity": "error"}]}\n```')
        self.assertFalse(report["ok"])
        self.assertEqual(len(report["issues"]), 1)

    def test_clean_caption_strips_leading_and_trailing_dot_runs(self):
        self.assertEqual(clean_caption(". . . Table 1. Data Sharing."), "Table 1. Data Sharing.")
        self.assertEqual(clean_caption("Table 2. Regression for 85 publications . ......."), "Table 2. Regression for 85 publications")

    def test_equation_limit_is_merged_back_into_equation_block(self):
        blocks = [
            {"type": "equation", "text": "Mp = max M(t). (2)", "page": 6, "section": "3. Method", "sourceIds": ["a"]},
            {"type": "paragraph", "text": "t∈[t1,t2]", "page": 6, "section": "3. Method", "sourceIds": ["b"]},
            {"type": "paragraph", "text": "The next paragraph begins here.", "page": 6, "section": "3. Method"},
        ]
        out, merged = merge_equation_limits(blocks)
        self.assertEqual(merged, 1)
        self.assertEqual([block["type"] for block in out], ["equation", "paragraph"])
        self.assertIn("t∈[t1,t2]", out[0]["text"])
        self.assertEqual(out[0]["sourceIds"], ["a", "b"])

    def test_cleanup_merges_short_table_caption_continuation(self):
        blocks = [
            {"type": "table", "page": 2, "caption": "Table 2. Regression for 85", "text": "Table 2. Regression for 85"},
            {"type": "paragraph", "page": 2, "text": ". . . publications . ................ ...."},
            {"type": "paragraph", "page": 2, "text": "."},
            {"type": "paragraph", "page": 2, "text": ". . doi:10.1/x.t002 ."},
        ]
        out, removed = cleanup_noise(blocks)
        self.assertEqual(len(out), 1)
        self.assertIn("publications", out[0]["caption"])
        self.assertGreaterEqual(removed, 3)

    def test_cleanup_does_not_merge_bare_word_into_table_caption(self):
        blocks = [
            {"type": "table", "page": 2, "caption": "TABLE 2", "text": "TABLE 2"},
            {"type": "paragraph", "page": 2, "text": "tection"},
        ]
        out, _ = cleanup_noise(blocks)
        self.assertEqual(out[0]["caption"], "TABLE 2")
        self.assertEqual(len(out), 2)

    def test_cleanup_keeps_repeated_short_search_operator(self):
        blocks = [
            {"type": "paragraph", "page": 4, "text": "[AND]"},
            {"type": "paragraph", "page": 5, "text": "[AND]"},
        ]
        out, removed = cleanup_noise(blocks)
        self.assertEqual([block["text"] for block in out], ["[AND]", "[AND]"])
        self.assertEqual(removed, 0)

    def test_cleanup_keeps_separator_block(self):
        blocks = [
            {"type": "paragraph", "page": 2, "text": "Before.", "bbox": [40, 100, 500, 110]},
            {"type": "separator", "page": 2, "text": "", "ruleId": "p002-hr001"},
            {"type": "paragraph", "page": 2, "text": "After.", "bbox": [40, 120, 500, 130]},
        ]
        out, removed = cleanup_noise(blocks)
        self.assertEqual([block["type"] for block in out], ["paragraph", "separator", "paragraph"])
        self.assertEqual(removed, 0)

    def test_content_rules_become_separator_or_special_visual_rule(self):
        blocks = [
            {"type": "paragraph", "page": 2, "bbox": [40, 100, 500, 110], "text": "Before."},
            {"type": "algorithm", "page": 2, "bbox": [40, 130, 500, 220], "text": "Algorithm 1"},
            {"type": "heading", "page": 2, "bbox": [40, 240, 500, 250], "text": "Next"},
        ]
        rules = [
            {"id": "p002-hr001", "page": 2, "top": 120, "bottom": 120, "x0": 40, "x1": 500},
            {"id": "p002-hr002", "page": 2, "top": 150, "bottom": 150, "x0": 40, "x1": 500},
            {"id": "p002-hr003", "page": 2, "top": 230, "bottom": 230, "x0": 40, "x1": 500},
        ]
        attach_content_rules(blocks, rules)
        self.assertEqual(
            [block["type"] for block in blocks],
            ["paragraph", "separator", "algorithm", "separator", "heading"],
        )
        self.assertEqual(
            [item["ruleId"] for item in blocks[2]["visualRules"]],
            ["p002-hr002"],
        )

    def test_supporting_information_is_split_into_headed_items(self):
        blocks = [{
            "type": "paragraph",
            "page": 5,
            "text": "Statistical analysis was performed. SUPPORTING INFORMATION Text S1 Cohort Bibliography Text S2 Locations Text S3 R-code",
        }]
        out, splits = split_supporting(blocks)
        self.assertEqual(splits, 1)
        texts = [block.get("text") for block in out]
        self.assertIn("SUPPORTING INFORMATION", texts)
        self.assertIn("Text S1", texts)
        self.assertIn("Text S2", texts)
        self.assertIn("Text S3", texts)

    def test_methods_s1_is_split_into_heading_and_body(self):
        blocks = [{
            "type": "paragraph",
            "page": 6,
            "text": "Methods S1 Primers used in this study Found at: doi:10.1371/journal.pone.0000309.s001",
        }]
        out, splits = split_supporting(blocks)
        self.assertEqual(splits, 1)
        self.assertEqual(out[0]["type"], "heading")
        self.assertEqual(out[0]["text"], "Methods S1")
        self.assertTrue(out[1]["text"].startswith("Primers used"))

    def test_text_quality_flags_glyph_soup(self):
        issues = text_quality_issues([
            {"id": "bad", "type": "heading", "page": 4, "text": "A. x e. n G c. h r. s a. b n. m C C C"},
            {"id": "ok", "type": "paragraph", "page": 3, "text": "Iowa, and E. coli isolated from a calf in North Dakota."},
        ])
        self.assertEqual([issue["blockId"] for issue in issues], ["bad"])
        self.assertIn("single-letter-interleave", issues[0]["reasons"])

    def test_bottom_full_width_table_is_ordered_after_both_columns(self):
        lines = [
            {"id": "l1", "page": 3, "columnScope": "left", "pageWidth": 600},
            {"id": "r1", "page": 3, "columnScope": "right", "pageWidth": 600},
            {"id": "t1", "page": 3, "columnScope": "full", "pageWidth": 600},
        ]
        blocks = [
            {"type": "paragraph", "page": 3, "sourceIds": ["r1"], "bbox": [320, 60, 550, 300], "text": "right"},
            {"type": "table", "page": 3, "sourceIds": ["t1"], "bbox": [60, 560, 550, 700], "text": "table"},
            {"type": "paragraph", "page": 3, "sourceIds": ["l1"], "bbox": [60, 60, 290, 300], "text": "left"},
        ]
        ordered = order_blocks_by_column(blocks, lines)
        self.assertEqual([block["type"] for block in ordered], ["paragraph", "paragraph", "table"])
        self.assertEqual(ordered[0]["column"], "left")
        self.assertEqual(ordered[1]["column"], "right")


class StructureAuditTests(unittest.TestCase):
    def test_unattached_figure_caption_is_reported(self):
        findings = detect_unattached_captions([
            {"id": "c", "type": "caption", "page": 2, "text": "Fig. 3. Missing plot"},
            {"id": "f", "type": "figure", "label": "Figure 2"},
        ])
        self.assertEqual(findings[0]["rule"], "figure.caption-unattached")

    def test_audit_is_clean_for_fully_assigned_simple_document(self):
        with tempfile.TemporaryDirectory() as raw:
            job = Path(raw)
            lines = [{
                "id": "p001-a",
                "page": 1,
                "role": "prose",
                "text": "A complete body paragraph.",
                "top": 100,
                "size": 10,
            }, {
                "id": "p001-dots",
                "page": 1,
                "role": "prose",
                "text": "........................",
                "top": 120,
                "size": 10,
            }]
            blocks = [{
                "id": "b0000",
                "type": "paragraph",
                "text": "A complete body paragraph.",
                "page": 1,
                "sourceIds": ["p001-a"],
            }]
            (job / "lines.json").write_text(json.dumps(lines), encoding="utf-8")
            (job / "mirrordoc.json").write_text(
                json.dumps({
                    "meta": {"title": "T", "pageCount": 1, "abstract": ""},
                    "blocks": blocks,
                }),
                encoding="utf-8",
            )
            (job / "layout-report.json").write_text(
                json.dumps({"warnings": [], "keyInfo": {}}),
                encoding="utf-8",
            )
            metrics = {
                "blocks": 1,
                "paragraphs": 1,
                "blockTypes": {"paragraph": 1},
            }
            (job / "report.md").write_text(
                "<!-- final-mirrordoc "
                + json.dumps(metrics, separators=(",", ":"))
                + " -->\n",
                encoding="utf-8",
            )
            report = build_report(job)
            self.assertTrue(report["ok"])
            self.assertEqual(report["findings"], [])

    def test_audit_flags_running_head_leaking_into_body(self):
        with tempfile.TemporaryDirectory() as raw:
            job = Path(raw)
            lines = [
                {
                    "id": "p002-h",
                    "page": 2,
                    "role": "prose",
                    "text": "AgriEngineering 2026, 8, 11 2 of 19",
                    "top": 36,
                    "size": 8,
                },
                {
                    "id": "p002-b",
                    "page": 2,
                    "role": "prose",
                    "text": "Body.",
                    "top": 75,
                    "size": 10,
                },
            ]
            blocks = [{
                "id": "b0000",
                "type": "paragraph",
                "text": "AgriEngineering 2026, 8, 11 2 of 19 Body.",
                "page": 2,
                "sourceIds": ["p002-h", "p002-b"],
            }]
            (job / "lines.json").write_text(json.dumps(lines), encoding="utf-8")
            (job / "mirrordoc.json").write_text(
                json.dumps({"meta": {"pageCount": 2}, "blocks": blocks}),
                encoding="utf-8",
            )
            (job / "layout-report.json").write_text("{}", encoding="utf-8")
            (job / "report.md").write_text(
                "<!-- final-mirrordoc "
                + json.dumps({"blocks": 1, "paragraphs": 1}, separators=(",", ":"))
                + " -->\n",
                encoding="utf-8",
            )
            report = build_report(job)
            rules = {item["rule"] for item in report["findings"]}
            self.assertIn("running-head.unclassified", rules)
            self.assertFalse(report["ok"])


if __name__ == "__main__":
    unittest.main()
