# Copyright (c) 2026 Sarthak Parulekar
# Licensed under MIT + Commons Clause — commercial use prohibited.

"""Logging for the sidecar.

Two problems this solves.

**Diagnostics vanish in a packaged build.** The sidecar is built with
``console=False`` and Electron spawns it with ``windowsHide``, so anything
written to stdout/stderr goes nowhere a user can retrieve. Every diagnostic
therefore also goes to a rotating file next to the Electron log, and the
Electron side surfaces that path when startup fails.

**Interview transcripts are the most sensitive thing this app touches.**
Logging them by default would turn a debugging aid into a plaintext record of
someone's interview, retained indefinitely. :func:`redact` returns a length and
a short digest instead of the text, which is enough to correlate a transcript
with the answer it produced without storing what was said. Set
``WINGMAN_LOG_TRANSCRIPTS=1`` to opt in while debugging.
"""

from __future__ import annotations

import hashlib
import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

LOG_FILE_NAME = "wingman-python.log"
MAX_LOG_BYTES = 2 * 1024 * 1024
LOG_BACKUP_COUNT = 2

_configured = False
_lock_message = "[wingman] logging is configured once per process"


def _log_transcripts_enabled() -> bool:
    return os.environ.get("WINGMAN_LOG_TRANSCRIPTS", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def _resolve_level() -> int:
    raw = os.environ.get("WINGMAN_LOG_LEVEL", "").strip().upper()
    return getattr(logging, raw, logging.INFO) if raw else logging.INFO


def _resolve_log_dir() -> Path | None:
    configured = os.environ.get("WINGMAN_LOG_DIR", "").strip()
    if configured:
        return Path(configured)

    history_dir = os.environ.get("WINGMAN_HISTORY_DIR", "").strip()
    if history_dir:
        # userData/history -> userData, so the Python log lands beside wingman.log.
        return Path(history_dir).parent

    return None


def configure_logging() -> None:
    """Idempotently attach a stderr handler and, when possible, a file handler."""

    global _configured
    if _configured:
        return
    _configured = True

    root = logging.getLogger("wingman")
    root.setLevel(_resolve_level())
    root.propagate = False

    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s [%(name)s] %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )

    stream_handler = logging.StreamHandler(sys.stderr)
    stream_handler.setFormatter(formatter)
    root.addHandler(stream_handler)

    log_dir = _resolve_log_dir()
    if log_dir is None:
        return

    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        file_handler = RotatingFileHandler(
            log_dir / LOG_FILE_NAME,
            maxBytes=MAX_LOG_BYTES,
            backupCount=LOG_BACKUP_COUNT,
            encoding="utf-8",
        )
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)
    except OSError as error:
        # A missing or read-only log directory must never stop the sidecar.
        root.warning("File logging disabled (%s)", error)


def get_logger(name: str) -> logging.Logger:
    configure_logging()
    return logging.getLogger(f"wingman.{name}")


def redact(text: str, limit: int = 40) -> str:
    """Render user speech as a correlatable, non-revealing token.

    Returns the real text only when ``WINGMAN_LOG_TRANSCRIPTS=1``.
    """

    if text is None:
        return "<none>"

    cleaned = str(text)
    if _log_transcripts_enabled():
        snippet = cleaned[:limit]
        suffix = "..." if len(cleaned) > limit else ""
        return f"{snippet!r}{suffix}"

    digest = hashlib.sha256(cleaned.encode("utf-8", "replace")).hexdigest()[:8]
    return f"<{len(cleaned)} chars, #{digest}>"
