# Copyright (c) 2026 Sarthak Parulekar
# Licensed under MIT + Commons Clause — commercial use prohibited.

"""Speech-to-text providers.

Two implementations share one interface (``start`` / ``feed`` / ``stop`` plus an
``on_transcript(text, is_final)`` callback):

``GroqTranscriber`` (default)
    Segments the stream locally and sends only speech to Groq Whisper. Uses the
    same API key as answer generation, so the app needs one free key total, and
    silence costs nothing. Latency is one utterance plus a round trip.

``DeepgramTranscriber``
    Opt-in streaming ASR with interim results. Lower latency, but it needs a
    second paid key and bills for connection time, silence included.
"""

from __future__ import annotations

import io
import json
import queue
import threading
import time
import wave
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from typing import Callable
from urllib.parse import urlencode

import httpx
import websocket
from groq import Groq

from vad import SAMPLE_RATE, Utterance, UtteranceSegmenter
from wingman_logging import get_logger

log = get_logger("transcriber")

DEFAULT_STT_MODEL = "whisper-large-v3-turbo"

# Whisper accepts a prompt for cross-chunk context. Kept short because it is
# billed as input and the model only honours the tail anyway.
CONTEXT_PROMPT_CHARS = 400
CONTEXT_SEGMENTS = 2

TRANSCRIBE_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = (0.6, 1.8)
# A Whisper call on a bounded utterance either lands in about half a second or
# is not going to. The SDK's 60s default is what let requests outlive sessions.
TRANSCRIBE_TIMEOUT_SECONDS = 15.0
RETRYABLE_STATUS = frozenset({408, 409, 429, 500, 502, 503, 504})

# Whisper hallucinates stock phrases on near-silent audio. These are dropped.
HALLUCINATION_BLOCKLIST = frozenset(
    (
        "thank you.",
        "thanks for watching!",
        "thank you for watching!",
        "thank you for watching.",
        "please subscribe.",
        "you",
        ".",
        "bye.",
        "okay.",
        "so.",
    )
)


def pcm_to_wav(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    """Wraps raw mono int16 PCM in a WAV container for upload."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm)
    return buffer.getvalue()


def _is_retryable(error: Exception) -> bool:
    status = getattr(error, "status_code", None)
    if isinstance(status, int):
        return status in RETRYABLE_STATUS

    name = type(error).__name__.lower()
    return any(
        marker in name
        for marker in ("connection", "timeout", "ratelimit", "internalserver", "apistatus")
    )


class GroqTranscriber:
    """Local VAD + Groq Whisper batch transcription."""

    def __init__(
        self,
        api_key: str,
        on_transcript: Callable[[str, bool], None],
        *,
        language: str = "en",
        model: str = DEFAULT_STT_MODEL,
        on_usage: Callable[[float], None] | None = None,
        on_activity: Callable[[bool], None] | None = None,
        on_error: Callable[[str], None] | None = None,
        max_workers: int = 2,
    ):
        api_key = api_key.strip()
        if not api_key:
            raise ValueError("A Groq API key is required for transcription.")

        # Retries are handled below, where they can be aborted on stop_event.
        # The SDK's own 60s read timeout is what lets a request outlive its
        # session; a Whisper call on a bounded utterance has no business
        # running that long.
        self.client = Groq(
            api_key=api_key,
            max_retries=0,
            timeout=httpx.Timeout(TRANSCRIBE_TIMEOUT_SECONDS, connect=5.0),
        )
        self.on_transcript = on_transcript
        self.on_usage = on_usage
        self.on_activity = on_activity
        self.on_error = on_error
        self.language = (language or "").strip().lower()
        self.model = model
        self.max_workers = max_workers

        self.segmenter = UtteranceSegmenter(
            on_speech_start=lambda: self._notify_activity(True),
            on_speech_end=lambda: self._notify_activity(False),
        )
        self.audio_queue: queue.Queue[bytes | None] = queue.Queue(maxsize=1024)
        self.stop_event = threading.Event()

        self._worker: threading.Thread | None = None
        self._executor: ThreadPoolExecutor | None = None

        self._context: deque[str] = deque(maxlen=CONTEXT_SEGMENTS)
        self._emit_lock = threading.Lock()
        self._pending: dict[int, str] = {}
        self._next_seq = 0
        self._emit_seq = 0

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        if self._worker is not None and self._worker.is_alive():
            return

        self.stop_event.clear()
        self._pending.clear()
        self._next_seq = 0
        self._emit_seq = 0
        self._context.clear()

        self._executor = ThreadPoolExecutor(
            max_workers=self.max_workers,
            thread_name_prefix="wingman-stt",
        )
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    def stop(self) -> None:
        self.stop_event.set()
        try:
            self.audio_queue.put_nowait(None)
        except queue.Full:
            pass

        worker = self._worker
        if worker is not None and worker.is_alive():
            worker.join(timeout=2.0)
        self._worker = None

        executor = self._executor
        self._executor = None
        if executor is not None:
            # Requests already in flight are abandoned; the session is over and
            # their transcripts would arrive after the UI has reset.
            executor.shutdown(wait=False, cancel_futures=True)

    def close(self) -> None:
        """Release the httpx connection pool. Safe to call after stop()."""
        try:
            self.client.close()
        except Exception as error:  # pragma: no cover - defensive
            log.debug("Transcriber client close failed: %s", error)

    def feed(self, audio_chunk: bytes) -> None:
        if not audio_chunk or self.stop_event.is_set():
            return

        try:
            self.audio_queue.put_nowait(audio_chunk)
        except queue.Full:
            # Drop the oldest audio rather than block the capture callback.
            try:
                self.audio_queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self.audio_queue.put_nowait(audio_chunk)
            except queue.Full:
                pass

    # ------------------------------------------------------------------
    # Worker
    # ------------------------------------------------------------------

    def _run(self) -> None:
        while not self.stop_event.is_set():
            try:
                chunk = self.audio_queue.get(timeout=0.2)
            except queue.Empty:
                continue

            if chunk is None:
                break

            try:
                completed = self.segmenter.push(chunk)
            except Exception as error:  # pragma: no cover - defensive
                log.error("VAD error: %s", error, exc_info=True)
                continue

            for utterance in completed:
                self._submit(utterance)

    def _submit(self, utterance: Utterance) -> None:
        executor = self._executor
        if executor is None or self.stop_event.is_set():
            return

        seq = self._next_seq
        self._next_seq += 1
        try:
            executor.submit(self._transcribe, seq, utterance)
        except RuntimeError:
            # Executor already shut down.
            pass

    def _transcribe(self, seq: int, utterance: Utterance) -> None:
        text = ""
        try:
            text = self._call_groq(utterance)
        except Exception as error:  # pragma: no cover - defensive
            log.error("Groq transcription failed: %s", error)
            self._notify_error(str(error))
        finally:
            self._emit_in_order(seq, text)

    def _call_groq(self, utterance: Utterance) -> str:
        wav_bytes = pcm_to_wav(utterance.pcm, self.segmenter.sample_rate)
        options: dict = {
            "model": self.model,
            "response_format": "text",
            "temperature": 0,
        }
        if self.language and self.language not in ("auto", "multi"):
            options["language"] = self.language

        prompt = self._context_prompt()
        if prompt:
            options["prompt"] = prompt

        last_error: Exception | None = None
        for attempt in range(TRANSCRIBE_ATTEMPTS):
            if self.stop_event.is_set():
                return ""

            try:
                response = self.client.audio.transcriptions.create(
                    file=("utterance.wav", wav_bytes),
                    **options,
                )
            except Exception as error:
                last_error = error
                if not _is_retryable(error) or attempt == TRANSCRIBE_ATTEMPTS - 1:
                    break
                time.sleep(RETRY_BACKOFF_SECONDS[min(attempt, len(RETRY_BACKOFF_SECONDS) - 1)])
                continue

            # Checked after the response, not before the request: an in-flight
            # request from a session that has since stopped would otherwise
            # report its seconds into the *next* session's usage tracker, which
            # _reset_runtime has already replaced.
            if self.stop_event.is_set():
                return ""

            if self.on_usage is not None:
                self.on_usage(utterance.seconds)
            return self._normalize(response)

        if last_error is not None:
            raise last_error
        return ""

    @staticmethod
    def _normalize(response: object) -> str:
        if isinstance(response, str):
            text = response
        else:
            text = str(getattr(response, "text", "") or "")

        text = " ".join(text.split()).strip()
        if not text:
            return ""

        if text.lower() in HALLUCINATION_BLOCKLIST:
            return ""

        return text

    def _context_prompt(self) -> str:
        if not self._context:
            return ""
        joined = " ".join(self._context).strip()
        return joined[-CONTEXT_PROMPT_CHARS:]

    def _emit_in_order(self, seq: int, text: str) -> None:
        """Releases transcripts in utterance order.

        Two requests run concurrently, so a short utterance can finish before
        the long one that preceded it. Emitting out of order would scramble a
        multi-sentence question.
        """
        ready: list[str] = []
        with self._emit_lock:
            self._pending[seq] = text
            while self._emit_seq in self._pending:
                value = self._pending.pop(self._emit_seq)
                self._emit_seq += 1
                if value:
                    self._context.append(value)
                    ready.append(value)

        if self.stop_event.is_set():
            return

        for value in ready:
            try:
                self.on_transcript(value, True)
            except Exception as error:  # pragma: no cover - defensive
                log.error("Transcript callback failed: %s", error, exc_info=True)

    def _notify_activity(self, active: bool) -> None:
        if self.on_activity is None or self.stop_event.is_set():
            return
        try:
            self.on_activity(active)
        except Exception as error:  # pragma: no cover - defensive
            log.error("Activity callback failed: %s", error, exc_info=True)

    def _notify_error(self, message: str) -> None:
        if self.on_error is None or self.stop_event.is_set():
            return
        try:
            self.on_error(message)
        except Exception:  # pragma: no cover - defensive
            pass


class DeepgramTranscriber:
    """Deepgram streaming ASR over a WebSocket."""

    def __init__(
        self,
        api_key: str,
        on_transcript: Callable[[str, bool], None],
        *,
        language: str = "en",
    ):
        self.api_key = api_key.strip()
        if not self.api_key:
            raise ValueError("A Deepgram API key is required for streaming transcription.")

        self.on_transcript = on_transcript
        self.language = (language or "en").strip().lower() or "en"
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
                "language": self.language,
                "encoding": "linear16",
                "sample_rate": SAMPLE_RATE,
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
            log.error("Deepgram transcript callback failed: %s", error, exc_info=True)

    def _handle_error(self, _ws: websocket.WebSocketApp, error):
        self._error_message = str(error)
        self.error_event.set()
        log.error("Deepgram WebSocket error: %s", error)

    def _handle_close(self, _ws: websocket.WebSocketApp, status_code, close_msg):
        self.closed_event.set()
        if not self.stop_event.is_set():
            log.warning(
                "Deepgram WebSocket closed unexpectedly: %s %s", status_code, close_msg
            )


def create_transcriber(
    provider: str,
    *,
    on_transcript: Callable[[str, bool], None],
    groq_api_key: str,
    deepgram_api_key: str = "",
    language: str = "en",
    stt_model: str = DEFAULT_STT_MODEL,
    on_usage: Callable[[float], None] | None = None,
    on_activity: Callable[[bool], None] | None = None,
    on_error: Callable[[str], None] | None = None,
):
    if provider == "deepgram":
        return DeepgramTranscriber(
            api_key=deepgram_api_key,
            on_transcript=on_transcript,
            language=language,
        )

    if provider != "groq":
        raise ValueError(f"Unknown transcription provider: {provider!r}")

    return GroqTranscriber(
        api_key=groq_api_key,
        on_transcript=on_transcript,
        language=language,
        model=stt_model,
        on_usage=on_usage,
        on_activity=on_activity,
        on_error=on_error,
    )
