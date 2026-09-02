# Copyright (c) 2026 Sarthak Parulekar
# SPDX-License-Identifier: MIT

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

PYTHON_DIR = Path(__file__).resolve().parents[1]
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

import fitz  # noqa: E402

import resume_parser  # noqa: E402
from resume_parser import ResumeParseError, extract_text_from_pdf  # noqa: E402


def build_pdf(pages: list[str]) -> bytes:
    """Render one page per string and return the serialised PDF."""
    document = fitz.open()
    for body in pages:
        page = document.new_page()
        # insert_textbox wraps, so a long line does not silently fall off the
        # page and vanish from the extracted text.
        page.insert_textbox(fitz.Rect(36, 36, 576, 756), body, fontsize=8)
    data = document.tobytes()
    document.close()
    return data


class ExtractTextTests(unittest.TestCase):
    def test_empty_input_returns_empty_string(self):
        self.assertEqual(extract_text_from_pdf(b""), "")

    def test_extracts_text_from_a_normal_pdf(self):
        pdf = build_pdf(["Senior Platform Engineer", "Built a low latency pipeline"])

        text = extract_text_from_pdf(pdf)

        self.assertIn("Senior Platform Engineer", text)
        self.assertIn("Built a low latency pipeline", text)

    def test_non_pdf_bytes_raise_a_handled_error(self):
        # MuPDF raises several unrelated exception types here; the point is that
        # none of them escape as a 500.
        with self.assertRaises(ResumeParseError):
            extract_text_from_pdf(b"PK\x03\x04 this is really a docx")

    def test_password_protected_pdf_says_so(self):
        document = fitz.open()
        document.new_page()
        encrypted = document.tobytes(
            encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="hunter2"
        )
        document.close()

        with self.assertRaises(ResumeParseError) as caught:
            extract_text_from_pdf(encrypted)

        self.assertIn("password", str(caught.exception).lower())


class ResourceBoundTests(unittest.TestCase):
    """The upload route hands attacker-controlled bytes to a native parser.

    Killing the sidecar also drops the WASAPI loopback device, so an OOM here
    ends the interview, not just the request.
    """

    def test_stops_reading_after_max_pages(self):
        pdf = build_pdf([f"page {index}" for index in range(8)])

        with mock.patch.object(resume_parser, "MAX_PAGES", 3):
            text = extract_text_from_pdf(pdf)

        self.assertIn("page 0", text)
        self.assertIn("page 2", text)
        self.assertNotIn("page 3", text)

    def test_caps_total_characters_across_pages(self):
        # Each page carries well over the patched budget, so the cap has to bite
        # part way through a page rather than between pages.
        pdf = build_pdf(["A" * 4000, "B" * 4000, "C" * 4000])

        with mock.patch.object(resume_parser, "MAX_EXTRACTED_CHARS", 500):
            text = extract_text_from_pdf(pdf)

        self.assertLessEqual(len(text), 500)
        # The bound must apply before the next page is read: a per-page-only
        # check would still let page two through.
        self.assertNotIn("C", text)

    def test_a_single_huge_page_cannot_exceed_the_budget(self):
        pdf = build_pdf(["Z" * 20000])

        with mock.patch.object(resume_parser, "MAX_EXTRACTED_CHARS", 256):
            text = extract_text_from_pdf(pdf)

        self.assertLessEqual(len(text), 256)

    def test_stops_reading_once_the_time_budget_is_spent(self):
        pdf = build_pdf([f"page {index}" for index in range(6)])

        # Anything with a time budget already exhausted must return what it has
        # rather than working through the remaining pages.
        with mock.patch.object(resume_parser, "MAX_PARSE_SECONDS", -1.0):
            text = extract_text_from_pdf(pdf)

        self.assertEqual(text, "")

    def test_bounds_do_not_truncate_a_realistic_resume(self):
        # Guards against tightening the caps to the point of breaking real use.
        pdf = build_pdf(["Experience\n" + ("Delivered a thing. " * 120)] * 3)

        text = extract_text_from_pdf(pdf)

        self.assertIn("Experience", text)
        self.assertGreater(len(text), 1000)


if __name__ == "__main__":
    unittest.main()
