from __future__ import annotations

import fitz


def extract_text_from_pdf(pdf_bytes: bytes) -> str:
    if not pdf_bytes:
        return ""

    text_segments: list[str] = []
    with fitz.open(stream=pdf_bytes, filetype="pdf") as document:
        for page in document:
            text_segments.append(page.get_text("text"))

    return "\n".join(segment.strip() for segment in text_segments if segment.strip()).strip()
