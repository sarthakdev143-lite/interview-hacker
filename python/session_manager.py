from __future__ import annotations

import json
import queue
import threading
import time
from pathlib import Path
from typing import Generator, Iterable
from uuid import uuid4

from audio_capture import AudioCapture
from llm import LLMClient
from transcriber import Transcriber

QUESTION_KEYWORDS = (
    "how ",
    "why ",
    "what ",
    "tell me",
    "explain",
    "describe",
    "can you",
    "could you",
    "walk me through",
)


class SessionManager:
    def __init__(self, history_dir: str):
        self.history_dir = Path(history_dir)
        self.history_dir.mkdir(parents=True, exist_ok=True)
        self.transcript_subscribers: set[queue.Queue] = set()
        self.answer_subscribers: set[queue.Queue] = set()
        self.answer_lock = threading.Lock()
        self.state_lock = threading.Lock()
        self._reset_runtime()

    def _reset_runtime(self):
        self.session_id = None
        self.session = {}
        self.status = "stopped"
        self.capture: AudioCapture | None = None
        self.transcriber: Transcriber | None = None
        self.llm: LLMClient | None = None
        self.audio_queue: queue.Queue[bytes] = queue.Queue(maxsize=512)
        self.stop_event = threading.Event()
        self.worker_thread: threading.Thread | None = None
        self.answer_thread: threading.Thread | None = None
        self.pending_question_segments: list[str] = []
        self.question_candidate_active = False
        self.last_transcript_at = 0.0
        self.started_at = None
        self.exchanges: list[dict] = []
        self.history_enabled = False

    def start_session(
        self,
        *,
        resume_text: str,
        extra_context: str,
        language: str,
        model: str,
        api_key: str,
        history_enabled: bool,
    ):
        self.stop_session()

        with self.state_lock:
            self.session_id = str(uuid4())
            self.session = {
                "resume_text": resume_text,
                "extra_context": extra_context,
                "language": language,
                "model": model,
            }
            self.status = "listening"
            self.history_enabled = history_enabled
            self.started_at = time.time()
            self.transcriber = Transcriber(api_key=api_key, language=language)
            self.llm = LLMClient(api_key=api_key)
            self.capture = AudioCapture(self._enqueue_audio)
            try:
                self.capture.start()
                self.worker_thread = threading.Thread(
                    target=self._transcription_loop,
                    daemon=True,
                )
                self.worker_thread.start()
            except Exception:
                self._reset_runtime()
                raise

        self._broadcast_transcript({"type": "status", "status": "listening"})
        return {"session_id": self.session_id, "status": self.status}

    def stop_session(self):
        capture = self.capture
        worker = self.worker_thread
        answer_thread = self.answer_thread
        history_enabled = self.history_enabled
        session_snapshot = {
            "session_id": self.session_id,
            "started_at": self.started_at,
            "exchanges": list(self.exchanges),
        }

        self.stop_event.set()

        if capture is not None:
            capture.stop()

        if worker is not None and worker.is_alive():
            worker.join(timeout=2.5)

        if answer_thread is not None and answer_thread.is_alive():
            answer_thread.join(timeout=2.0)

        if history_enabled:
            self._save_history(session_snapshot)

        self.status = "stopped"
        self._broadcast_transcript({"type": "status", "status": "stopped"})
        self._broadcast_answer({"type": "status", "status": "stopped"})
        self._reset_runtime()
        return {"status": "stopped"}

    def manual_answer(self, prompt: str) -> Generator[dict, None, None]:
        if not self.llm or not self.session_id:
            raise RuntimeError("Start a session before requesting a manual answer.")

        local_queue: queue.Queue = queue.Queue()
        threading.Thread(
            target=self._stream_answer_worker,
            args=(prompt, local_queue),
            daemon=True,
        ).start()
        return self._yield_queue(local_queue)

    def subscribe_transcripts(self) -> Generator[dict, None, None]:
        subscriber: queue.Queue = queue.Queue()
        self.transcript_subscribers.add(subscriber)
        return self._yield_queue(subscriber, kind="transcript")

    def subscribe_answers(self) -> Generator[dict, None, None]:
        subscriber: queue.Queue = queue.Queue()
        self.answer_subscribers.add(subscriber)
        return self._yield_queue(subscriber, kind="answer")

    def list_history(self):
        sessions = []
        for file_path in sorted(self.history_dir.glob("*.json"), reverse=True):
            try:
                sessions.append(json.loads(file_path.read_text(encoding="utf-8")))
            except Exception:
                continue
        return sessions

    def _yield_queue(self, subscriber: queue.Queue, kind: str | None = None):
        collection = (
            self.transcript_subscribers if kind == "transcript" else self.answer_subscribers
        )

        if self.status and kind == "transcript":
            subscriber.put({"type": "status", "status": self.status})

        try:
            while True:
                try:
                    item = subscriber.get(timeout=15)
                    yield item
                    if item.get("type") == "done":
                        break
                except queue.Empty:
                    yield {"type": "heartbeat"}
        finally:
            collection.discard(subscriber)

    def _enqueue_audio(self, audio_chunk: bytes):
        if self.stop_event.is_set():
            return
        try:
            self.audio_queue.put_nowait(audio_chunk)
        except queue.Full:
            try:
                self.audio_queue.get_nowait()
            except queue.Empty:
                pass
            self.audio_queue.put_nowait(audio_chunk)

    def _transcription_loop(self):
        while not self.stop_event.is_set():
            try:
                audio_chunk = self.audio_queue.get(timeout=0.25)
            except queue.Empty:
                self._flush_pending_question_if_ready()
                continue

            try:
                text = self.transcriber.feed(audio_chunk) if self.transcriber else None
                if text:
                    self._publish_transcript(text)
            except Exception as error:
                print(f"[wingman] Transcription error: {error}")

            self._flush_pending_question_if_ready()

        if self.transcriber is not None:
            try:
                tail = self.transcriber.flush()
                if tail:
                    self._publish_transcript(tail)
            except Exception as error:
                print(f"[wingman] Final transcription flush failed: {error}")

        self._flush_pending_question_if_ready(force=True)

    def _publish_transcript(self, text: str):
        normalized = " ".join(text.split()).strip()
        if not normalized:
            return

        self.status = "transcribing"
        self._broadcast_transcript({"type": "status", "status": "transcribing"})

        is_question_candidate = self._looks_like_question(normalized)
        self.last_transcript_at = time.time()

        if is_question_candidate:
            self.question_candidate_active = True

        if self.question_candidate_active:
            self.pending_question_segments.append(normalized)

        self._broadcast_transcript(
            {
                "type": "transcript",
                "text": normalized,
                "is_question": is_question_candidate,
            }
        )

    def _flush_pending_question_if_ready(self, force: bool = False):
        if not self.question_candidate_active or not self.pending_question_segments:
            return

        if not force and (time.time() - self.last_transcript_at) < 2.0:
            return

        question = " ".join(self.pending_question_segments).strip()
        self.pending_question_segments = []
        self.question_candidate_active = False

        try:
            is_question = self.llm.is_question(question) if self.llm else False
        except Exception as error:
            print(f"[wingman] Question classification failed, using heuristic: {error}")
            is_question = True

        if not is_question:
            self.status = "listening"
            self._broadcast_transcript({"type": "status", "status": "listening"})
            return

        self.answer_thread = threading.Thread(
            target=self._stream_answer_worker,
            args=(question, None),
            daemon=True,
        )
        self.answer_thread.start()

    def _stream_answer_worker(self, prompt: str, local_queue: queue.Queue | None):
        if not self.llm:
            return

        with self.answer_lock:
            self.status = "thinking"
            self._fan_out({"type": "status", "status": "thinking"}, local_queue)
            tokens: list[str] = []

            try:
                for token in self.llm.stream_answer(prompt, self.session):
                    if self.stop_event.is_set():
                        break

                    if self.status != "answering":
                        self.status = "answering"
                        self._fan_out({"type": "status", "status": "answering"}, local_queue)

                    tokens.append(token)
                    self._fan_out({"type": "token", "text": token}, local_queue)
            except Exception as error:
                fallback = "I lost the answer stream. Please ask the question again."
                print(f"[wingman] Answer generation failed: {error}")
                tokens = [fallback]
                self._fan_out({"type": "token", "text": fallback}, local_queue)

            answer = "".join(tokens).strip()
            if answer:
                self.exchanges.append(
                    {
                        "question": prompt,
                        "answer": answer,
                        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    }
                )

            self.status = "done"
            self._fan_out({"type": "done"}, local_queue)
            self._broadcast_transcript({"type": "status", "status": "listening"})
            self.status = "listening"

    def _fan_out(self, payload: dict, local_queue: queue.Queue | None):
        self._broadcast_answer(payload)
        if local_queue is not None:
            local_queue.put(payload)

    def _broadcast_transcript(self, payload: dict):
        self._broadcast(self.transcript_subscribers, payload)

    def _broadcast_answer(self, payload: dict):
        self._broadcast(self.answer_subscribers, payload)

    @staticmethod
    def _broadcast(subscribers: Iterable[queue.Queue], payload: dict):
        for subscriber in list(subscribers):
            try:
                subscriber.put_nowait(payload)
            except queue.Full:
                continue

    @staticmethod
    def _looks_like_question(text: str) -> bool:
        lowered = f" {text.lower()} "
        if text.strip().endswith("?"):
            return True
        return any(keyword in lowered for keyword in QUESTION_KEYWORDS)

    def _save_history(self, session_snapshot: dict):
        session_id = session_snapshot.get("session_id")
        started_at = session_snapshot.get("started_at")
        exchanges = session_snapshot.get("exchanges", [])
        if not session_id or not started_at or not exchanges:
            return

        finished_at = time.time()
        record = {
            "session_id": session_id,
            "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started_at)),
            "duration_seconds": int(finished_at - started_at),
            "exchanges": exchanges,
        }

        file_path = self.history_dir / f"{record['date'].replace(':', '-')}_{session_id}.json"
        file_path.write_text(json.dumps(record, indent=2), encoding="utf-8")
