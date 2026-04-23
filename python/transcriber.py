from __future__ import annotations

import json
import queue
import threading
import time
from typing import Callable
from urllib.parse import urlencode

import websocket


class Transcriber:
    def __init__(
        self,
        api_key: str,
        on_transcript: Callable[[str, bool], None],
    ):
        self.api_key = api_key.strip()
        if not self.api_key:
            raise ValueError("A Deepgram API key is required for streaming transcription.")

        self.on_transcript = on_transcript
        self.audio_queue: queue.Queue[bytes | None] = queue.Queue(maxsize=1024)
        self.ws: websocket.WebSocketApp | None = None
        self.ws_thread: threading.Thread | None = None
        self.sender_thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.open_event = threading.Event()
        self.closed_event = threading.Event()
        self.error_event = threading.Event()
        self._last_interim_text = ""
        self._error_message: str | None = None

    def start(self):
        if self.ws_thread is not None and self.ws_thread.is_alive():
            return

        self.stop_event.clear()
        self.open_event.clear()
        self.closed_event.clear()
        self.error_event.clear()
        self._error_message = None
        self._last_interim_text = ""

        params = urlencode(
            {
                "model": "nova-2",
                "encoding": "linear16",
                "sample_rate": 16000,
                "channels": 1,
                "punctuate": "true",
                "endpointing": 800,
                "utterance_end_ms": 1000,
                "vad_events": "true",
                "interim_results": "true",
            }
        )
        url = f"wss://api.deepgram.com/v1/listen?{params}"

        self.ws = websocket.WebSocketApp(
            url,
            header=[f"Authorization: Token {self.api_key}"],
            on_open=self._handle_open,
            on_message=self._handle_message,
            on_error=self._handle_error,
            on_close=self._handle_close,
        )
        self.ws_thread = threading.Thread(target=self._run_socket, daemon=True)
        self.sender_thread = threading.Thread(target=self._send_audio_loop, daemon=True)
        self.ws_thread.start()
        self.sender_thread.start()

        deadline = time.time() + 10
        while time.time() < deadline:
            if self.open_event.is_set():
                return
            if self.error_event.is_set():
                self.stop()
                raise RuntimeError(
                    self._error_message or "Deepgram connection failed before it became ready."
                )
            if self.closed_event.is_set():
                self.stop()
                raise RuntimeError("Deepgram connection closed before it became ready.")
            time.sleep(0.05)

        self.stop()
        raise RuntimeError("Timed out while connecting to Deepgram streaming ASR.")

    def stop(self):
        self.stop_event.set()
        try:
            self.audio_queue.put_nowait(None)
        except queue.Full:
            try:
                self.audio_queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self.audio_queue.put_nowait(None)
            except queue.Full:
                pass

        if self.ws is not None:
            try:
                if self.open_event.is_set():
                    self.ws.send(json.dumps({"type": "CloseStream"}))
            except Exception:
                pass
            try:
                self.ws.close()
            except Exception:
                pass

        if self.sender_thread is not None and self.sender_thread.is_alive():
            self.sender_thread.join(timeout=2.0)
        if self.ws_thread is not None and self.ws_thread.is_alive():
            self.ws_thread.join(timeout=3.0)

        self.ws = None
        self.sender_thread = None
        self.ws_thread = None

    def feed(self, audio_chunk: bytes):
        if not audio_chunk or self.stop_event.is_set():
            return

        try:
            self.audio_queue.put_nowait(audio_chunk)
        except queue.Full:
            try:
                self.audio_queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self.audio_queue.put_nowait(audio_chunk)
            except queue.Full:
                pass

    def _run_socket(self):
        if self.ws is None:
            return

        try:
            self.ws.run_forever(ping_interval=20, ping_timeout=10)
        except Exception as error:
            self._error_message = str(error)
            self.error_event.set()
            self.closed_event.set()

    def _send_audio_loop(self):
        while not self.stop_event.is_set():
            try:
                audio_chunk = self.audio_queue.get(timeout=0.25)
            except queue.Empty:
                continue

            if audio_chunk is None:
                return

            if not self.open_event.wait(timeout=5):
                if self.stop_event.is_set():
                    return
                continue

            if self.ws is None:
                return

            try:
                self.ws.send(audio_chunk, opcode=websocket.ABNF.OPCODE_BINARY)
            except Exception as error:
                self._error_message = str(error)
                self.error_event.set()
                return

    def _handle_open(self, _ws: websocket.WebSocketApp):
        self.open_event.set()

    def _handle_message(self, _ws: websocket.WebSocketApp, message: str):
        try:
            payload = json.loads(message)
        except json.JSONDecodeError:
            return

        if payload.get("type") != "Results":
            return

        channel = payload.get("channel") or {}
        alternatives = channel.get("alternatives") or []
        transcript = ""
        if alternatives:
            transcript = str(alternatives[0].get("transcript", "")).strip()

        is_final = bool(payload.get("is_final"))
        if not transcript:
            if is_final:
                self._last_interim_text = ""
            return

        if not is_final and transcript == self._last_interim_text:
            return

        if is_final:
            self._last_interim_text = ""
        else:
            self._last_interim_text = transcript

        try:
            self.on_transcript(transcript, is_final)
        except Exception as error:
            print(f"[wingman] Deepgram transcript callback failed: {error}")

    def _handle_error(self, _ws: websocket.WebSocketApp, error):
        self._error_message = str(error)
        self.error_event.set()
        print(f"[wingman] Deepgram WebSocket error: {error}")

    def _handle_close(self, _ws: websocket.WebSocketApp, status_code, close_msg):
        self.closed_event.set()
        if not self.stop_event.is_set():
            print(
                f"[wingman] Deepgram WebSocket closed unexpectedly: "
                f"{status_code} {close_msg}"
            )
