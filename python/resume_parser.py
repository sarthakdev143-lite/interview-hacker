# Copyright (c) 2026 Sarthak Parulekar
# SPDX-License-Identifier: MIT

from __future__ import annotations

import time

import fitz

from wingman_logging import get_logger

log = get_logger("resume")

# Deep enough for any real resume, shallow enough that a crafted PDF cannot make
# this loop for minutes.
MAX_PAGES = 50

# MAX_PAGES bounds how many pages are visited, but not how much text each one
# yields. PDF content streams are Flate-compressed, so a small upload can
# decompress into far more text inside a native parser — the caller's 10 MB
# request cap is not a bound on the output. The server truncates the result to
# MAX_RESUME_CHARS (60k) anyway, but it did so only after the full join, by
# which point the memory had already been committed. Killing the sidecar
# mid-interview also drops the audio capture device, so this is worth bounding
# generously rather than tightly.
MAX_EXTRACTED_CHARS = 200_000

# A page can also be slow rather than large — deeply nested clipping paths and
# pathological font programs cost CPU per page without producing much text.
MAX_PARSE_SECONDS = 10.0


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
            started = time.monotonic()
            remaining = MAX_EXTRACTED_CHARS

            for index, page in enumerate(document):
                if index >= MAX_PAGES:
                    break

                if time.monotonic() - started > MAX_PARSE_SECONDS:
                    log.warning(
                        "Stopped reading PDF after %.1fs at page %d of %d",
                        MAX_PARSE_SECONDS,
                        index,
                        document.page_count,
                    )
                    break

                segment = page.get_text("text")

                # Checked per page rather than once at the end: a single page
                # is enough to exhaust memory, so the bound has to apply before
                # the next page is read, not after the loop.
                if len(segment) > remaining:
                    segment = segment[:remaining]

                text_segments.append(segment)
                remaining -= len(segment)

                if remaining <= 0:
                    log.warning(
                        "PDF exceeded %d characters; truncated at page %d",
                        MAX_EXTRACTED_CHARS,
                        index,
                    )
                    break
    except ResumeParseError:
        raise
    except Exception as error:
        raise ResumeParseError(
            "That PDF could not be read. Try re-exporting it, or paste the text instead."
        ) from error

    return "\n".join(
        segment.strip() for segment in text_segments if segment.strip()
    ).strip()
