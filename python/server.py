# Copyright (c) 2026 Sarthak Parulekar
# Licensed under MIT + Commons Clause — commercial use prohibited.

from __future__ import annotations

import json
import hmac
import os
import platform as _platform
import sys
import threading
import time
from typing import Generator

from flask import Flask, Response, jsonify, request
from flask_cors import CORS
from werkzeug.serving import WSGIRequestHandler, make_server

from groq import Groq

from audio_capture import probe_audio_environment
from llm import (
    ANSWER_MODEL_PREFERENCES,
    DEFAULT_ANSWER_MODEL,
    list_chat_models,
    pick_model,
)
from resume_parser import extract_text_from_pdf
from session_manager import DEFAULT_TRANSCRIPTION_PROVIDER, SessionManager
from wingman_logging import get_logger

log = get_logger("server")

SUPPORTED_TRANSCRIPTION_PROVIDERS = ("groq", "deepgram")

# A resume is a handful of pages. Anything past this is a mistake or an attempt
# to exhaust memory, and Werkzeug rejects it before the body is buffered.
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
# Bounds on free-text fields forwarded to the LLM. Generous for real input,
# finite for anything else.
MAX_RESUME_CHARS = 60_000
MAX_CONTEXT_CHARS = 20_000
MAX_PROMPT_CHARS = 8_000
MAX_MODEL_CHARS = 128
MAX_LANGUAGE_CHARS = 32

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES
CORS(
    app,
    allow_headers=["Content-Type", "X-Wingman-Token"],
    origins=["file://", "null", "http://127.0.0.1:*", "http://localhost:*"],
)

history_dir = os.environ.get("WINGMAN_HISTORY_DIR", os.path.join(os.getcwd(), "history"))
server_token = os.environ.get("WINGMAN_SERVER_TOKEN", "")
sessions = SessionManager(history_dir)
server_holder: dict[str, object] = {"server": None, "port": 0}


class QuietRequestHandler(WSGIRequestHandler):
    """Access log without the query string.

    EventSource cannot set headers, so SSE passes the server token as
    ``?token=``. The default handler writes the full request line to stderr,
    which Electron buffers and embeds verbatim into startup error messages —
    putting the secret in a log and a dialog.
    """

    def log_request(self, code="-", size="-"):
        requestline = str(self.requestline).split("?", 1)[0]
        log.debug('"%s" %s %s', requestline, code, size)

    def log_error(self, format, *args):  # noqa: A002 - base class signature
        log.warning(format, *args)

    def log_message(self, format, *args):  # noqa: A002 - base class signature
        log.debug(format, *args)


def clamp(value: object, limit: int) -> str:
    return str(value or "").strip()[:limit]


def sse_format(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def stream_events(events: Generator[dict, None, None]):
    for event in events:
        if event.get("type") == "heartbeat":
            yield ": ping\n\n"
            continue
        yield sse_format(event)


@app.before_request
def require_server_token():
    if request.method == "OPTIONS" or not server_token:
        return None

    supplied_token = request.headers.get("X-Wingman-Token") or request.args.get("token")
    if not supplied_token or not hmac.compare_digest(supplied_token, server_token):
        return jsonify({"error": "Forbidden"}), 403

    return None


@app.errorhandler(413)
def payload_too_large(_error):
    return (
        jsonify(
            {
                "error": f"File is larger than the {MAX_UPLOAD_BYTES // (1024 * 1024)}MB limit."
            }
        ),
        413,
    )


@app.post("/session/start")
def start_session():
    payload = request.get_json(force=True, silent=False) or {}
    api_key = str(payload.get("api_key", "")).strip()
    if not api_key:
        return jsonify({"error": "api_key is required"}), 400

    provider = str(
        payload.get("transcription_provider") or DEFAULT_TRANSCRIPTION_PROVIDER
    ).strip().lower()
    if provider not in SUPPORTED_TRANSCRIPTION_PROVIDERS:
        return jsonify({"error": f"Unsupported transcription provider: {provider}"}), 400

    deepgram_api_key = str(
        payload.get("deepgram_api_key") or os.environ.get("DEEPGRAM_API_KEY", "")
    ).strip()
    # Only the Deepgram provider needs a second key. The default Groq provider
    # reuses the key that already powers answer generation.
    if provider == "deepgram" and not deepgram_api_key:
        return jsonify({"error": "deepgram_api_key is required"}), 400

    try:
        result = sessions.start_session(
            resume_text=clamp(payload.get("resume_text"), MAX_RESUME_CHARS),
            extra_context=clamp(payload.get("extra_context"), MAX_CONTEXT_CHARS),
            language=clamp(payload.get("language"), MAX_LANGUAGE_CHARS) or "en",
            model=clamp(payload.get("model"), MAX_MODEL_CHARS) or DEFAULT_ANSWER_MODEL,
            api_key=api_key,
            deepgram_api_key=deepgram_api_key,
            history_enabled=bool(payload.get("history_enabled", False)),
            transcription_provider=provider,
        )
    except (RuntimeError, ValueError) as error:
        return jsonify({"error": str(error)}), 400

    return jsonify(result)


@app.post("/session/stop")
def stop_session():
    return jsonify(sessions.stop_session())


@app.post("/resume/upload")
def upload_resume():
    file = request.files.get("file")
    if file is None:
        return jsonify({"error": "Missing PDF file upload."}), 400

    pdf_bytes = file.read()
    resume_text = extract_text_from_pdf(pdf_bytes)
    return jsonify({"resume_text": resume_text})


@app.get("/transcript/stream")
def transcript_stream():
    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    }
    return Response(
        stream_events(sessions.subscribe_transcripts()),
        mimetype="text/event-stream",
        headers=headers,
    )


@app.get("/answer/stream")
def answer_stream():
    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    }
    return Response(
        stream_events(sessions.subscribe_answers()),
        mimetype="text/event-stream",
        headers=headers,
    )


@app.post("/answer/manual")
def answer_manual():
    payload = request.get_json(force=True, silent=False) or {}
    prompt = clamp(payload.get("prompt"), MAX_PROMPT_CHARS)
    if not prompt:
        return jsonify({"error": "prompt is required"}), 400

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    }
    try:
        generator = sessions.manual_answer(prompt)
    except RuntimeError as error:
        return jsonify({"error": str(error)}), 400

    return Response(
        stream_events(generator),
        mimetype="text/event-stream",
        headers=headers,
    )


@app.get("/history")
def get_history():
    return jsonify({"sessions": sessions.list_history()})


@app.get("/usage")
def get_usage():
    return jsonify({"usage": sessions.current_usage()})


@app.post("/models")
def get_models():
    """Chat models this API key can actually reach.

    Groq retires model IDs, so the picker is populated from the live account
    rather than a hard-coded list that silently goes stale.
    """
    payload = request.get_json(force=True, silent=True) or {}
    api_key = str(payload.get("api_key", "")).strip()
    if not api_key:
        return jsonify({"error": "api_key is required"}), 400

    models = list_chat_models(Groq(api_key=api_key))
    return jsonify(
        {
            "models": models,
            "recommended": pick_model(
                ANSWER_MODEL_PREFERENCES, models, DEFAULT_ANSWER_MODEL
            ),
        }
    )


@app.get("/health")
def health():
    audio_probe = probe_audio_environment()
    return jsonify(
        {
            "status": "ok",
            "port": server_holder["port"],
            "platform": sys.platform,
            "transcription_providers": list(SUPPORTED_TRANSCRIPTION_PROVIDERS),
            "default_transcription_provider": DEFAULT_TRANSCRIPTION_PROVIDER,
            "capture_warning": sys.platform == "win32"
            and _platform.version() < "10.0.22621",
            "audio": {
                "ready": audio_probe.ready,
                "message": audio_probe.message,
                "suggested_device": audio_probe.suggested_device,
            },
        }
    )


@app.post("/shutdown")
def shutdown():
    sessions.stop_session()
    server = server_holder.get("server")
    if server is not None:
        threading.Thread(target=server.shutdown, daemon=True).start()
    return jsonify({"status": "shutting-down"})


PARENT_POLL_SECONDS = 2.0


def _parent_is_alive(parent_pid: int) -> bool:
    if sys.platform == "win32":
        import ctypes

        # STILL_ACTIVE. OpenProcess fails outright once the handle is gone.
        process_handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, parent_pid)
        if not process_handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            ok = ctypes.windll.kernel32.GetExitCodeProcess(
                process_handle, ctypes.byref(exit_code)
            )
            return bool(ok) and exit_code.value == 259
        finally:
            ctypes.windll.kernel32.CloseHandle(process_handle)

    try:
        os.kill(parent_pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def start_parent_watchdog() -> None:
    """Exit when the Electron process that spawned us is gone.

    The sidecar holds the loopback capture device and a listening socket. If
    Electron is killed from Task Manager, or crashes hard, its shutdown path
    never runs and this process survives — busy device, stale port, and a
    background process the user did not ask for.
    """
    raw_pid = os.environ.get("WINGMAN_PARENT_PID", "").strip()
    if not raw_pid.isdigit():
        return

    parent_pid = int(raw_pid)

    def watch():
        while True:
            time.sleep(PARENT_POLL_SECONDS)
            if _parent_is_alive(parent_pid):
                continue
            log.warning("Parent process %s is gone; shutting down.", parent_pid)
            try:
                sessions.stop_session()
            except Exception:
                log.debug("Session stop during watchdog exit failed", exc_info=True)
            # os._exit rather than a graceful shutdown: there is no client left
            # to serve, and serve_forever is on the main thread.
            os._exit(0)

    threading.Thread(target=watch, name="wingman-parent-watchdog", daemon=True).start()


def main() -> int:

    # This is Werkzeug's server, invoked programmatically. That is a deliberate
    # choice, not an oversight: the sidecar is bound to loopback with a single
    # local client, and a production WSGI server would add a dependency and a
    # process for no benefit. Do not expose this beyond 127.0.0.1.
    start_parent_watchdog()
    server = make_server(
        "127.0.0.1", 0, app, threaded=True, request_handler=QuietRequestHandler
    )
    server_holder["server"] = server
    server_holder["port"] = server.server_port
    log.info("Listening on 127.0.0.1:%s", server.server_port)
    # The handshake line Electron waits for. Must stay on stdout and stay first.
    print(f"PORT:{server.server_port}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
