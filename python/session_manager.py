from __future__ import annotations

import json
import queue
import threading
import time
from collections import deque
from pathlib import Path
from typing import Generator, Iterable
from uuid import uuid4

import numpy as np

from audio_capture import AudioCapture
from llm import LLMClient
from transcriber import Transcriber

QUESTION_KEYWORDS = (
    "how ",
    "why ",
    "what ",
    "when ",
    "where ",
    "who ",
    "which ",
    "tell me",
    "explain",
    "describe",
    "can you",
    "could you",
    "would you",
    "do you",
    "did you",
    "have you",
    "are you",
    "walk me through",
)
QUESTION_SETTLE_SECONDS = 0.9
SILENCE_HANGOVER_SECONDS = 0.6
PCM_BYTES_PER_SECOND = 16000 * 2
PRE_ROLL_SECONDS = 0.45
SPEECH_RMS_THRESHOLD = 28
SPEECH_RMS_MULTIPLIER = 1.8
NOISE_FLOOR_SMOOTHING = 0.08


class SessionManager:
    def __init__(self, history_dir: str):
        self.history_dir = Path(history_dir)
        self.history_dir.mkdir(parents=True, exist_ok=True)
        self.transcript_subscribers: set[queue.Queue] = set()
        self.answer_subscribers: set[queue.Queue] = set()
        self.state_lock = threading.Lock()
        self.runtime_id = 0
        self._reset_runtime()

    def _reset_runtime(self):
        self.session_id = None
        self.session = {}
        self.status = "stopped"
        self.capture: AudioCapture | None = None
        self.transcriber: Transcriber | None = None
        self.llm: LLMClient | None = None
        self.audio_queue: queue.Queue[bytes] = queue.Queue(maxsize=512)
        self.answer_queue: queue.Queue[tuple[str, queue.Queue | None]] = queue.Queue()
        self.stop_event = threading.Event()
        self.worker_thread: threading.Thread | None = None
        self.answer_worker_thread: threading.Thread | None = None
        self.pending_utterance_segments: list[str] = []
        self.pending_question_segments: list[str] = []
        self.question_candidate_active = False
        self.last_transcript_at = 0.0
        self.last_voice_activity_at = 0.0
        self.speech_active = False
        self.pre_roll_chunks: deque[bytes] = deque()
        self.pre_roll_buffered_bytes = 0
        self.noise_floor_rms = 0.0
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
            self.runtime_id += 1
            runtime_id = self.runtime_id
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
                    args=(runtime_id, self.stop_event, self.audio_queue),
                    daemon=True,
                )
                self.worker_thread.start()
                self.answer_worker_thread = threading.Thread(
                    target=self._answer_loop,
                    args=(runtime_id, self.stop_event, self.answer_queue),
                    daemon=True,
                )
                self.answer_worker_thread.start()
            except Exception:
                self._reset_runtime()
                raise

        self._broadcast_transcript({"type": "status", "status": "listening"})
        return {"session_id": self.session_id, "status": self.status}

    def stop_session(self):
        capture = self.capture
        worker = self.worker_thread
        answer_worker = self.answer_worker_thread
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

        if answer_worker is not None and answer_worker.is_alive():
            answer_worker.join(timeout=2.0)

        if history_enabled:
            self._save_history(session_snapshot)

        self.status = "stopped"
        self._broadcast_transcript({"type": "status", "status": "stopped"})
        self._broadcast_answer({"type": "status", "status": "stopped"})
        self.runtime_id += 1
        self._reset_runtime()
        return {"status": "stopped"}

    def manual_answer(self, prompt: str) -> Generator[dict, None, None]:
        if not self.llm or not self.session_id:
            raise RuntimeError("Start a session before requesting a manual answer.")

        local_queue: queue.Queue = queue.Queue()
        self.answer_queue.put((prompt, local_queue))
        return self._yield_queue(local_queue, close_on_done=True)

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

    def _yield_queue(
        self,
        subscriber: queue.Queue,
        kind: str | None = None,
        close_on_done: bool = False,
    ):
        collection = None
        if kind == "transcript":
            collection = self.transcript_subscribers
        elif kind == "answer":
            collection = self.answer_subscribers

        if self.status and kind == "transcript":
            subscriber.put({"type": "status", "status": self.status})
        elif self.status and kind == "answer":
            subscriber.put({"type": "status", "status": self.status})

        try:
            while True:
                try:
                    item = subscriber.get(timeout=15)
                    yield item
                    if close_on_done and item.get("type") == "done":
                        break
                except queue.Empty:
                    yield {"type": "heartbeat"}
        finally:
            if collection is not None:
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

    def _transcription_loop(
        self,
        runtime_id: int,
        stop_event: threading.Event,
        audio_queue: queue.Queue[bytes],
    ):
        while not stop_event.is_set():
            try:
                audio_chunk = audio_queue.get(timeout=0.25)
            except queue.Empty:
                self._flush_transcriber_if_ready()
                self._flush_pending_question_if_ready()
                continue

            try:
                self._process_audio_chunk(audio_chunk)
            except Exception as error:
                print(f"[wingman] Transcription error: {error}")

            self._flush_transcriber_if_ready()
            self._flush_pending_question_if_ready()

        if self._runtime_is_active(runtime_id, stop_event):
            self._flush_transcriber_if_ready(force=True)
            self._flush_pending_question_if_ready(force=True)

    def _answer_loop(
        self,
        runtime_id: int,
        stop_event: threading.Event,
        answer_queue: queue.Queue[tuple[str, queue.Queue | None]],
    ):
        while True:
            if stop_event.is_set() and answer_queue.empty():
                return

            try:
                prompt, local_queue = answer_queue.get(timeout=0.25)
            except queue.Empty:
                continue

            try:
                llm = self.llm
                session = dict(self.session)
                self._stream_answer_worker(
                    runtime_id,
                    stop_event,
                    llm,
                    session,
                    prompt,
                    local_queue,
                )
            finally:
                answer_queue.task_done()

    def _process_audio_chunk(self, audio_chunk: bytes):
        if not self.transcriber:
            return

        if not self.speech_active:
            self._buffer_pre_roll_chunk(audio_chunk)

        rms = self._chunk_rms(audio_chunk)
        chunk_has_speech = self._chunk_has_speech(rms)
        if chunk_has_speech:
            self.speech_active = True
            self.last_voice_activity_at = time.time()
            if self.pre_roll_chunks:
                text = self._prime_transcriber_from_pre_roll()
                if text:
                    self._publish_transcript(text)
                return

        if not self.speech_active:
            return

        text = self.transcriber.feed(audio_chunk)
        if text:
            self._publish_transcript(text)

    def _flush_transcriber_if_ready(self, force: bool = False):
        if not self.transcriber or not self.speech_active or not self.transcriber.has_buffered_audio():
            return

        if not force and (time.time() - self.last_voice_activity_at) < SILENCE_HANGOVER_SECONDS:
            return

        try:
            tail = self.transcriber.flush()
            if tail:
                self._publish_transcript(tail)
        except Exception as error:
            print(f"[wingman] Final transcription flush failed: {error}")
        finally:
            self.speech_active = False
            self._clear_pre_roll_buffer()

    def _publish_transcript(self, text: str):
        normalized = " ".join(text.split()).strip()
        if not normalized:
            return

        self.status = "transcribing"
        self._broadcast_transcript({"type": "status", "status": "transcribing"})

        is_question_candidate = self._looks_like_question(normalized)
        self.last_transcript_at = time.time()
        self.pending_utterance_segments.append(normalized)

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
        if not self.pending_utterance_segments:
            return

        if not force and (time.time() - self.last_transcript_at) < QUESTION_SETTLE_SECONDS:
            return

        utterance = " ".join(self.pending_utterance_segments).strip()
        self.pending_utterance_segments = []
        question = " ".join(self.pending_question_segments).strip()
        self.pending_question_segments = []
        had_question_candidate = self.question_candidate_active
        should_classify = had_question_candidate or self._should_check_as_question(utterance)
        self.question_candidate_active = False

        if not should_classify:
            self.status = "listening"
            self._broadcast_transcript({"type": "status", "status": "listening"})
            return

        prompt = question or utterance
        try:
            is_question = self.llm.is_question(prompt) if self.llm else False
        except Exception as error:
            print(f"[wingman] Question classification failed, using heuristic: {error}")
            is_question = had_question_candidate or self._looks_like_question(prompt)

        if not is_question:
            self.status = "listening"
            self._broadcast_transcript({"type": "status", "status": "listening"})
            return

        self.answer_queue.put((prompt, None))

    def _stream_answer_worker(
        self,
        runtime_id: int,
        stop_event: threading.Event,
        llm: LLMClient | None,
        session: dict,
        prompt: str,
        local_queue: queue.Queue | None,
    ):
        if not llm or not self._runtime_is_active(runtime_id, stop_event):
            return

        self.status = "thinking"
        self._fan_out(
            runtime_id,
            stop_event,
            {"type": "status", "status": "thinking"},
            local_queue,
        )
        tokens: list[str] = []

        try:
            for token in llm.stream_answer(prompt, session):
                if not self._runtime_is_active(runtime_id, stop_event):
                    break

                if self.status != "answering":
                    self.status = "answering"
                    self._fan_out(
                        runtime_id,
                        stop_event,
                        {"type": "status", "status": "answering"},
                        local_queue,
                    )

                tokens.append(token)
                self._fan_out(
                    runtime_id,
                    stop_event,
                    {"type": "token", "text": token},
                    local_queue,
                )
        except Exception as error:
            fallback = "I lost the answer stream. Please ask the question again."
            print(f"[wingman] Answer generation failed: {error}")
            if self._runtime_is_active(runtime_id, stop_event):
                tokens = [fallback]
                self._fan_out(
                    runtime_id,
                    stop_event,
                    {"type": "token", "text": fallback},
                    local_queue,
                )

        if not self._runtime_is_active(runtime_id, stop_event):
            return

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
        self._fan_out(runtime_id, stop_event, {"type": "done"}, local_queue)
        self._broadcast_transcript({"type": "status", "status": "listening"})
        self.status = "listening"

    def _fan_out(
        self,
        runtime_id: int,
        stop_event: threading.Event,
        payload: dict,
        local_queue: queue.Queue | None,
    ):
        if not self._runtime_is_active(runtime_id, stop_event):
            return
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

    @staticmethod
    def _should_check_as_question(text: str) -> bool:
        normalized = " ".join(text.split()).strip()
        if not normalized:
            return False

        word_count = len(normalized.split())
        return normalized.endswith("?") or word_count >= 6

    def _runtime_is_active(self, runtime_id: int, stop_event: threading.Event) -> bool:
        return self.runtime_id == runtime_id and not stop_event.is_set()

    @staticmethod
    def _chunk_rms(audio_chunk: bytes) -> float:
        samples = np.frombuffer(audio_chunk, dtype=np.int16)
        if samples.size == 0:
            return 0.0
        return float(np.sqrt(np.mean(np.square(samples.astype(np.float32)))))

    def _chunk_has_speech(self, rms: float) -> bool:
        threshold = max(
            SPEECH_RMS_THRESHOLD,
            self.noise_floor_rms * SPEECH_RMS_MULTIPLIER,
        )
        has_speech = rms >= threshold

        if not self.speech_active and not has_speech:
            if self.noise_floor_rms <= 0:
                self.noise_floor_rms = rms
            else:
                self.noise_floor_rms = (
                    self.noise_floor_rms * (1 - NOISE_FLOOR_SMOOTHING)
                    + rms * NOISE_FLOOR_SMOOTHING
                )

        return has_speech

    def _buffer_pre_roll_chunk(self, audio_chunk: bytes):
        self.pre_roll_chunks.append(audio_chunk)
        self.pre_roll_buffered_bytes += len(audio_chunk)

        max_bytes = int(PRE_ROLL_SECONDS * PCM_BYTES_PER_SECOND)
        while self.pre_roll_buffered_bytes > max_bytes and self.pre_roll_chunks:
            removed = self.pre_roll_chunks.popleft()
            self.pre_roll_buffered_bytes -= len(removed)

    def _prime_transcriber_from_pre_roll(self):
        if not self.transcriber:
            return None

        primed_texts: list[str] = []
        for chunk in self.pre_roll_chunks:
            text = self.transcriber.feed(chunk)
            if text:
                primed_texts.append(text)

        self._clear_pre_roll_buffer()
        if not primed_texts:
            return None

        return " ".join(primed_texts).strip()

    def _clear_pre_roll_buffer(self):
        self.pre_roll_chunks.clear()
        self.pre_roll_buffered_bytes = 0

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
