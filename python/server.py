# Copyright (c) 2026 Sarthak Parulekar
# Licensed under MIT + Commons Clause — commercial use prohibited.

from __future__ import annotations

import json
import hmac
import os
import platform as _platform
import sys
import threading
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

app = Flask(__name__)
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
            resume_text=str(payload.get("resume_text", "")).strip(),
            extra_context=str(payload.get("extra_context", "")).strip(),
            language=str(payload.get("language", "en")).strip() or "en",
            model=str(payload.get("model") or DEFAULT_ANSWER_MODEL).strip(),
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
    prompt = str(payload.get("prompt", "")).strip()
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


if __name__ == "__main__":
    server = make_server("127.0.0.1", 0, app, threaded=True)
    server_holder["server"] = server
    server_holder["port"] = server.server_port
    print(f"PORT:{server.server_port}", flush=True)
    server.serve_forever()
