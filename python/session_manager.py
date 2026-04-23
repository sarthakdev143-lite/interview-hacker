# Copyright (c) 2026 Sarthak Parulekar
# Licensed under MIT + Commons Clause — commercial use prohibited.

from __future__ import annotations

import json
import queue
import threading
import time
from collections import deque
from pathlib import Path
from typing import Generator, Iterable
from uuid import uuid4

from audio_capture import AudioCapture
from llm import LLMClient
from transcriber import Transcriber

# ---------------------------------------------------------------------------
# Question-detection heuristics
# ---------------------------------------------------------------------------

QUESTION_KEYWORDS = (
    "how ",
    "why ",
    "what ",
    "where ",
    "when ",
    "which ",
    "who ",
    "tell me",
    "explain",
    "describe",
    "can you",
    "could you",
    "walk me through",
    "what's",
    "what is",
    "have you",
    "do you",
    "did you",
    "would you",
    "will you",
    "are you",
    "were you",
    "is there",
    "is it",
    "give me",
    "talk about",
    "thoughts on",
    "opinion on",
    "familiar with",
    "experience with",
    "know about",
)

PROMPT_LEAD_INS = (
    "please share",
    "please explain",
    "please describe",
    "please tell",
    "please walk",
    "share one",
    "share a",
    "share an",
)

DIRECT_QUESTION_PREFIXES = (
    "how ",
    "why ",
    "what ",
    "where ",
    "when ",
    "which ",
    "who ",
    "tell me",
    "tell us",
    "explain",
    "describe",
    "can you",
    "could you",
    "walk me through",
    "walk us through",
    "what's",
    "what is",
    "what are",
    "have you",
    "do you",
    "did you",
    "would you",
    "will you",
    "are you",
    "were you",
    "is there",
    "is it",
    "give me",
    "talk about",
    "thoughts on",
    "opinion on",
    "familiar with",
    "experience with",
    "know about",
    "please share",
    "please explain",
    "please describe",
    "please tell",
    "please walk",
    "share one",
    "share a",
    "share an",
    "tell us about yourself",
    "introduce yourself",
    "walk us through your resume",
    "compare ",
    "difference between",
    "what happens",
    "how would you",
    "how do you",
    "how did you",
    "let's say",
    "suppose",
    "imagine",
)

CANDIDATE_ANSWER_LEAD_INS = (
    "sure ",
    "of course",
    "absolutely",
    "great question",
    "so i ",
    "i think",
    "i believe",
    "i would",
    "i have",
    "i've ",
    "i used",
    "i worked",
    "i built",
    "i designed",
    "yeah ",
    "yes ",
    "no ",
    "well ",
    "actually",
    "definitely",
    "certainly",
)

FILLER_PATTERNS = frozenset(
    (
        "thank you",
        "thanks",
        "you're welcome",
        "ok",
        "okay",
        "alright",
        "right",
        "mm",
        "hmm",
        "uh",
        "um",
        "ah",
    )
)

# ---------------------------------------------------------------------------
# Timing constants
# ---------------------------------------------------------------------------

QUESTION_SETTLE_SECONDS = 0.45

MAX_QUESTION_SEGMENTS = 20
MIN_SEGMENT_CHARS = 6
CONTEXT_LOOKBACK_SEGMENTS = 6


class SessionManager:
    def __init__(self, history_dir: str):
        self.history_dir = Path(history_dir)
        self.history_dir.mkdir(parents=True, exist_ok=True)
        self.transcript_subscribers: set[queue.Queue] = set()
        self.answer_subscribers: set[queue.Queue] = set()
        self.state_lock = threading.Lock()
        self.subscriber_lock = threading.Lock()
        self.runtime_id: int = 0
        self._reset_runtime()

    # ------------------------------------------------------------------
    # Internal state
    # ------------------------------------------------------------------

    def _reset_runtime(self):
        self.session_id = None
        self.session: dict = {}
        self.status = "stopped"
        self.capture: AudioCapture | None = None
        self.transcriber: Transcriber | None = None
        self.llm: LLMClient | None = None
        self.audio_queue: queue.Queue[bytes] = queue.Queue(maxsize=512)
        self.answer_queue: queue.Queue[tuple[str, queue.Queue | None]] = queue.Queue()
        self.stop_event = threading.Event()
        self.worker_thread: threading.Thread | None = None
        self.answer_worker_thread: threading.Thread | None = None

        self.pending_question_segments: list[str] = []
        self.pending_utterance_segments: list[str] = []

        self.last_transcript_at = 0.0
        self._recent_context: deque[str] = deque(maxlen=CONTEXT_LOOKBACK_SEGMENTS)

        self.started_at: float | None = None
        self.exchanges: list[dict] = []
        self.history_enabled = False
        self._last_enqueued_question: str = ""

    # ------------------------------------------------------------------
    # Session lifecycle
    # ------------------------------------------------------------------

    def start_session(
        self,
        *,
        resume_text: str,
        extra_context: str,
        language: str,
        model: str,
        api_key: str,
        deepgram_api_key: str,
        history_enabled: bool,
    ) -> dict:
        self.stop_session()

        with self.state_lock:
            self.runtime_id += 1
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
            self.transcriber = Transcriber(
                api_key=deepgram_api_key,
                on_transcript=self._on_deepgram_transcript,
            )
            self.llm = LLMClient(api_key=api_key)
            self.capture = AudioCapture(self._enqueue_audio)
            try:
                self.transcriber.start()
                self.worker_thread = threading.Thread(
                    target=self._transcription_loop, daemon=True
                )
                self.worker_thread.start()
                self.answer_worker_thread = threading.Thread(
                    target=self._answer_loop, daemon=True
                )
                self.answer_worker_thread.start()
                self.capture.start()
            except Exception:
                if self.capture is not None:
                    self.capture.stop()
                if self.transcriber is not None:
                    self.transcriber.stop()
                self._reset_runtime()
                raise

        self._broadcast_transcript({"type": "status", "status": "listening"})
        return {"session_id": self.session_id, "status": self.status}

    def stop_session(self) -> dict:
        capture = self.capture
        transcriber = self.transcriber
        worker = self.worker_thread
        answer_worker = self.answer_worker_thread
        history_enabled = self.history_enabled
        session_id = self.session_id
        started_at = self.started_at

        self.stop_event.set()

        if capture is not None:
            capture.stop()
        if transcriber is not None:
            transcriber.stop()
        if worker is not None and worker.is_alive():
            worker.join(timeout=2.5)
        if answer_worker is not None and answer_worker.is_alive():
            answer_worker.join(timeout=2.0)

        if history_enabled:
            session_snapshot = {
                "session_id": session_id,
                "started_at": started_at,
                "exchanges": list(self.exchanges),
            }
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
        self.answer_queue.put((prompt, local_queue))
        return self._yield_queue(local_queue, close_on_done=True)

    # ------------------------------------------------------------------
    # SSE subscriptions
    # ------------------------------------------------------------------

    def subscribe_transcripts(self) -> Generator[dict, None, None]:
        subscriber: queue.Queue = queue.Queue(maxsize=256)
        with self.subscriber_lock:
            self.transcript_subscribers.add(subscriber)
        return self._yield_queue(subscriber, kind="transcript")

    def subscribe_answers(self) -> Generator[dict, None, None]:
        subscriber: queue.Queue = queue.Queue(maxsize=256)
        with self.subscriber_lock:
            self.answer_subscribers.add(subscriber)
        return self._yield_queue(subscriber, kind="answer")

    def list_history(self) -> list:
        sessions = []
        for file_path in sorted(self.history_dir.glob("*.json"), reverse=True):
            try:
                sessions.append(json.loads(file_path.read_text(encoding="utf-8")))
            except Exception:
                continue
        return sessions

    # ------------------------------------------------------------------
    # Queue / generator helpers
    # ------------------------------------------------------------------

    def _yield_queue(
        self,
        subscriber: queue.Queue,
        kind: str | None = None,
        close_on_done: bool = False,
    ):
        collection: set | None = None
        if kind == "transcript":
            collection = self.transcript_subscribers
        elif kind == "answer":
            collection = self.answer_subscribers

        if kind in ("transcript", "answer"):
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
                with self.subscriber_lock:
                    collection.discard(subscriber)

    # ------------------------------------------------------------------
    # Audio ingestion
    # ------------------------------------------------------------------

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

    # ------------------------------------------------------------------
    # Transcription loop
    # ------------------------------------------------------------------

    def _transcription_loop(self):
        while not self.stop_event.is_set():
            try:
                audio_chunk = self.audio_queue.get(timeout=0.25)
            except queue.Empty:
                self._flush_pending_question_if_ready()
                continue

            try:
                self._process_audio_chunk(audio_chunk)
            except Exception as error:
                print(f"[wingman] Transcription error: {error}")

            self._flush_pending_question_if_ready()

        self._flush_pending_question_if_ready(force=True)

    def _answer_loop(self):
        while True:
            if self.stop_event.is_set() and self.answer_queue.empty():
                return
            try:
                prompt, local_queue = self.answer_queue.get(timeout=0.25)
            except queue.Empty:
                continue

            runtime_id = self.runtime_id
            stop_event = self.stop_event
            llm = self.llm
            session = dict(self.session)

            try:
                self._stream_answer_worker(
                    runtime_id, stop_event, llm, session, prompt, local_queue
                )
            finally:
                self.answer_queue.task_done()

    # ------------------------------------------------------------------
    # Audio to transcript
    # ------------------------------------------------------------------

    def _process_audio_chunk(self, audio_chunk: bytes):
        if not self.transcriber:
            return
        self.transcriber.feed(audio_chunk)

    def _on_deepgram_transcript(self, text: str, is_final: bool):
        normalized = " ".join(text.split()).strip()
        if not normalized:
            return

        if is_final:
            self._publish_transcript(normalized)
            return

        self._broadcast_transcript(
            {
                "type": "transcript",
                "text": normalized,
                "interim": True,
                "is_question": False,
            }
        )

    # ------------------------------------------------------------------
    # Transcript to question detection
    # ------------------------------------------------------------------

    def _publish_transcript(self, text: str):
        normalized = " ".join(text.split()).strip()
        if not normalized or len(normalized) < MIN_SEGMENT_CHARS:
            return

        if self._is_filler(normalized):
            return

        self.status = "transcribing"
        self._broadcast_transcript({"type": "status", "status": "transcribing"})
        self.last_transcript_at = time.time()

        has_question_signal = self._looks_like_question(normalized)
        has_prompt_signal = self._looks_like_interview_prompt(normalized)
        has_answer_lead_in = self._looks_like_candidate_answer(normalized)

        if self.pending_question_segments and has_answer_lead_in:
            print(f"[wingman] Answer lead-in, early flush: {normalized!r}")
            self._flush_pending_question_if_ready(force=True)
            self.pending_utterance_segments.append(normalized)
        elif has_question_signal or has_prompt_signal or self.pending_question_segments:
            if len(self.pending_question_segments) < MAX_QUESTION_SEGMENTS:
                self.pending_question_segments.append(normalized)
        else:
            self._recent_context.append(normalized)

        self._broadcast_transcript(
            {
                "type": "transcript",
                "text": normalized,
                "is_question": has_question_signal or has_prompt_signal,
            }
        )

    def _flush_pending_question_if_ready(self, force: bool = False):
        if not self.pending_question_segments:
            return

        if not force and (time.time() - self.last_transcript_at) < QUESTION_SETTLE_SECONDS:
            return

        segments = list(self.pending_question_segments)
        while segments and self._is_filler(segments[-1]):
            segments.pop()

        self.pending_question_segments = []

        if not segments:
            self._go_listening()
            return

        all_segments = list(self._recent_context) + segments
        question = " ".join(all_segments).strip()

        for seg in segments:
            self._recent_context.append(seg)

        if not (
            self._looks_like_question(question)
            or self._looks_like_interview_prompt(question)
        ):
            print(f"[wingman] No question signal, skipping classifier: {question!r:.120}")
            self._go_listening()
            return

        if question == self._last_enqueued_question:
            print("[wingman] Duplicate question, skipping")
            self._go_listening()
            return

        if self._looks_like_direct_question(segments, question):
            print(f"[wingman] Direct question, enqueueing: {question!r:.200}")
            self._enqueue_question(question)
            return

        print(f"[wingman] Classifying: {question!r:.200}")
        threading.Thread(
            target=self._classify_and_enqueue,
            args=(question, self.runtime_id, self.stop_event, self.llm),
            daemon=True,
        ).start()

    def _classify_and_enqueue(
        self,
        question: str,
        runtime_id: int,
        stop_event: threading.Event,
        llm: LLMClient | None,
    ):
        if stop_event.is_set() or self.runtime_id != runtime_id:
            return

        try:
            is_question = llm.is_question(question) if llm else False
        except Exception as error:
            print(f"[wingman] Classifier failed, assuming yes: {error}")
            is_question = True

        if stop_event.is_set() or self.runtime_id != runtime_id:
            return

        if not is_question:
            print(f"[wingman] LLM says NOT a question: {question!r:.120}")
            self._go_listening()
            return

        print(f"[wingman] QUESTION CONFIRMED: {question!r:.200}")
        self._enqueue_question(question)

    def _enqueue_question(self, question: str):
        self._recent_context.clear()
        self.pending_utterance_segments = []
        self._last_enqueued_question = question
        self.answer_queue.put((question, None))

    def _go_listening(self):
        self.status = "listening"
        self._broadcast_transcript({"type": "status", "status": "listening"})

    # ------------------------------------------------------------------
    # Answer streaming
    # ------------------------------------------------------------------

    def _stream_answer_worker(
        self,
        runtime_id: int,
        stop_event: threading.Event,
        llm: LLMClient | None,
        session: dict,
        prompt: str,
        local_queue: queue.Queue | None,
    ):
        if not llm:
            return

        def fan(payload: dict):
            if self.runtime_id != runtime_id:
                return
            self._broadcast_answer(payload)
            if local_queue is not None:
                local_queue.put(payload)

        self.status = "thinking"
        fan({"type": "status", "status": "thinking"})
        tokens: list[str] = []

        try:
            for token in llm.stream_answer(prompt, session):
                if stop_event.is_set() or self.runtime_id != runtime_id:
                    break
                if self.status != "answering":
                    self.status = "answering"
                    fan({"type": "status", "status": "answering"})
                tokens.append(token)
                fan({"type": "token", "text": token})
        except Exception as error:
            fallback = "I lost the answer stream. Please ask the question again."
            print(f"[wingman] Answer generation failed: {error}")
            tokens = [fallback]
            fan({"type": "token", "text": fallback})

        answer = "".join(tokens).strip()
        if answer and self.runtime_id == runtime_id:
            self.exchanges.append(
                {
                    "question": prompt,
                    "answer": answer,
                    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
            )

        if self.runtime_id == runtime_id:
            fan({"type": "done"})
            self._broadcast_transcript({"type": "status", "status": "listening"})
            self.status = "listening"
            self._last_enqueued_question = ""

    # ------------------------------------------------------------------
    # Broadcast helpers
    # ------------------------------------------------------------------

    def _broadcast_transcript(self, payload: dict):
        self._broadcast(self.transcript_subscribers, payload)

    def _broadcast_answer(self, payload: dict):
        self._broadcast(self.answer_subscribers, payload)

    def _broadcast(self, subscribers: Iterable[queue.Queue], payload: dict):
        with self.subscriber_lock:
            subscriber_snapshot = list(subscribers)

        for subscriber in subscriber_snapshot:
            try:
                subscriber.put_nowait(payload)
            except queue.Full:
                try:
                    subscriber.get_nowait()
                except queue.Empty:
                    pass
                try:
                    subscriber.put_nowait(payload)
                except queue.Full:
                    continue

    # ------------------------------------------------------------------
    # Heuristics
    # ------------------------------------------------------------------

    @staticmethod
    def _looks_like_question(text: str) -> bool:
        if text.strip().endswith("?"):
            return True
        lowered = f" {text.lower()} "
        return any(kw in lowered for kw in QUESTION_KEYWORDS)

    @staticmethod
    def _looks_like_interview_prompt(text: str) -> bool:
        lowered = text.lower().strip()
        return any(lowered.startswith(lead) for lead in PROMPT_LEAD_INS)

    @staticmethod
    def _looks_like_direct_question(segments: list[str], text: str) -> bool:
        if text.strip().endswith("?"):
            return True

        candidates = [text, *segments]
        return any(
            candidate.lower().strip().startswith(prefix)
            for candidate in candidates
            for prefix in DIRECT_QUESTION_PREFIXES
        )

    @staticmethod
    def _looks_like_candidate_answer(text: str) -> bool:
        lowered = text.lower().strip()
        return any(lowered.startswith(lead.strip()) for lead in CANDIDATE_ANSWER_LEAD_INS)

    @staticmethod
    def _is_filler(text: str) -> bool:
        lowered = text.lower().strip().rstrip(".,!?")
        return lowered in FILLER_PATTERNS

    # ------------------------------------------------------------------
    # History
    # ------------------------------------------------------------------

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
        file_path = (
            self.history_dir
            / f"{record['date'].replace(':', '-')}_{session_id}.json"
        )
        file_path.write_text(json.dumps(record, indent=2), encoding="utf-8")
