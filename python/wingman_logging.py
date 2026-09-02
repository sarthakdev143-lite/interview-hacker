# Copyright (c) 2026 Sarthak Parulekar
# SPDX-License-Identifier: MIT

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


def restrict_permissions(path: Path, mode: int) -> None:
    """Best-effort ``chmod`` that never takes the caller down with it.

    POSIX creates files as ``0o666 & ~umask`` and directories as
    ``0o777 & ~umask``, which normally means 0o644/0o755 — readable by every
    local account. This app writes API-key ciphertext, diagnostic logs and
    plaintext interview transcripts, none of which other users need.

    ``chmod`` is a no-op on Windows for anything but the read-only bit, and can
    fail on exotic or network filesystems. Neither case is worth aborting a
    session for, so failures are swallowed: the caller has already decided the
    write itself must succeed.
    """
    if os.name == "nt":
        return

    try:
        os.chmod(path, mode)
    except OSError:
        pass


# Internal alias so the logging setup below reads consistently with callers.
_restrict_permissions = restrict_permissions


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
        log_path = log_dir / LOG_FILE_NAME
        file_handler = RotatingFileHandler(
            log_path,
            maxBytes=MAX_LOG_BYTES,
            backupCount=LOG_BACKUP_COUNT,
            encoding="utf-8",
        )
        # The default is 0o666 & ~umask, so on a typical POSIX box the log is
        # world-readable. Even redacted it records session timing and model
        # errors, and under WINGMAN_LOG_TRANSCRIPTS=1 it holds real interview
        # text. Both the directory and the current file are tightened; rotated
        # backups inherit the mode because logging renames rather than recreates.
        # A no-op on Windows, where the userData ACL already governs access.
        _restrict_permissions(log_dir, 0o700)
        _restrict_permissions(log_path, 0o600)
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
