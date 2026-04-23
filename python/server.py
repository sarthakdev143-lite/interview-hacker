from __future__ import annotations

import json
import hmac
import os
import sys
import threading
from typing import Generator

from flask import Flask, Response, jsonify, request
from flask_cors import CORS
from werkzeug.serving import make_server

from audio_capture import probe_audio_environment
from resume_parser import extract_text_from_pdf
from session_manager import SessionManager

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
    deepgram_api_key = str(
        payload.get("deepgram_api_key") or os.environ.get("DEEPGRAM_API_KEY", "")
    ).strip()
    if not deepgram_api_key:
        return jsonify({"error": "deepgram_api_key is required"}), 400

    result = sessions.start_session(
        resume_text=str(payload.get("resume_text", "")).strip(),
        extra_context=str(payload.get("extra_context", "")).strip(),
        language=str(payload.get("language", "en")).strip() or "en",
        model=str(payload.get("model", "llama-3.3-70b-versatile")).strip(),
        api_key=api_key,
        deepgram_api_key=deepgram_api_key,
        history_enabled=bool(payload.get("history_enabled", False)),
    )
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


@app.get("/health")
def health():
    audio_probe = probe_audio_environment()
    return jsonify(
        {
            "status": "ok",
            "port": server_holder["port"],
            "platform": sys.platform,
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
