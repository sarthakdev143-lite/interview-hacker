# Copyright (c) 2026 Sarthak Parulekar
# SPDX-License-Identifier: MIT

from __future__ import annotations

import fitz

# Deep enough for any real resume, shallow enough that a crafted PDF cannot make
# this loop for minutes.
MAX_PAGES = 50


class ResumeParseError(Exception):
    """The upload could not be read as a PDF.

    MuPDF raises several unrelated exception types for the same user-visible
    problem ("that file isn't a PDF I can read"), and letting them escape turned
    a mis-picked .docx into an HTTP 500. Callers catch this and show the message.
    """


def extract_text_from_pdf(pdf_bytes: bytes) -> str:
    if not pdf_bytes:
        return ""

    text_segments: list[str] = []
    try:
        with fitz.open(stream=pdf_bytes, filetype="pdf") as document:
            if document.needs_pass:
                raise ResumeParseError(
                    "That PDF is password protected. Remove the password and try again."
                )
            for index, page in enumerate(document):
                if index >= MAX_PAGES:
                    break
                text_segments.append(page.get_text("text"))
    except ResumeParseError:
        raise
    except Exception as error:
        raise ResumeParseError(
            "That PDF could not be read. Try re-exporting it, or paste the text instead."
        ) from error

    return "\n".join(
        segment.strip() for segment in text_segments if segment.strip()
    ).strip()
