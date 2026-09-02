# Copyright (c) 2026 Sarthak Parulekar
# SPDX-License-Identifier: MIT

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
from llm import LLMClient, is_rate_limit
from transcriber import DEFAULT_STT_MODEL, create_transcriber
from usage import UsageTracker
from wingman_logging import get_logger, redact, restrict_permissions

log = get_logger("session")

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

# How long to wait after a transcript before treating the question as finished.
#
# Deepgram emits several finals per sentence, so the window is what joins them
# back into one question.
QUESTION_SETTLE_SECONDS = 0.45

# The Groq provider segments on silence locally and only ever emits complete
# utterances, so there is nothing to wait for. Measured end to end, the 0.45 s
# window was 455 ms of a 1233 ms end-of-question-to-first-token budget, and it
# joined nothing: a pause long enough to split an utterance (700 ms of VAD
# hangover) already pushes the next transcript well outside the window. A short
# window remains only to absorb two utterances finishing near-simultaneously.
UTTERANCE_SETTLE_SECONDS = 0.08

# Providers that deliver whole utterances rather than incremental fragments.
COMPLETE_UTTERANCE_PROVIDERS = frozenset({"groq"})

MAX_QUESTION_SEGMENTS = 20
MIN_SEGMENT_CHARS = 6

# Bounds on what a non-English utterance must look like before it is worth a
# classifier call: long enough to be a real prompt, short enough not to be a
# monologue the candidate is already answering.
MIN_CLASSIFIER_WORDS = 3
MAX_CLASSIFIER_WORDS = 60
CONTEXT_LOOKBACK_SEGMENTS = 6

DEFAULT_TRANSCRIPTION_PROVIDER = "groq"

# Spend updates are cheap to compute but noisy to stream, so they are throttled.
USAGE_BROADCAST_INTERVAL_SECONDS = 3.0

# A stalled Groq stream can hold the answer worker well past stop_session's join
# timeout. Rather than wait for it, stop invalidates the runtime so the straggler
# can never emit, and these caps bound what it can consume on the way out.
MAX_CONCURRENT_CLASSIFIERS = 3
MAX_PENDING_ANSWERS = 8
MAX_SSE_SUBSCRIBERS = 16
MAX_HISTORY_SESSIONS = 200


class SessionManager:
    def __init__(self, history_dir: str):
        self.history_dir = Path(history_dir)
        self.history_dir.mkdir(parents=True, exist_ok=True)
        # Holds plaintext transcripts of every saved session.
        restrict_permissions(self.history_dir, 0o700)
        self.transcript_subscribers: set[queue.Queue] = set()
        self.answer_subscribers: set[queue.Queue] = set()
        self.state_lock = threading.Lock()
        # start_session calls stop_session, so this has to be re-entrant. It is
        # held across the whole of both, which is what keeps two concurrent
        # POST /session/start requests from interleaving a teardown into a build.
        self.lifecycle_lock = threading.RLock()
        self.subscriber_lock = threading.Lock()
        self.runtime_id: int = 0
        self._classifier_slots = threading.Semaphore(MAX_CONCURRENT_CLASSIFIERS)
        self._reset_runtime()

    # ------------------------------------------------------------------
    # Internal state
    # ------------------------------------------------------------------

    def _close_clients(self):
        """Release the httpx connection pools owned by this runtime.

        Both LLMClient and GroqTranscriber construct their own Groq client, and
        dropping the reference leaves the pool to the garbage collector. Over
        many start/stop cycles that is two leaked pools per session.
        """
        for client in (self.llm, self.transcriber):
            close = getattr(client, "close", None)
            if close is None:
                continue
            try:
                close()
            except Exception as error:
                log.debug("Client close failed: %s", error)

    def _reset_runtime(self):
        self.session_id = None
        self.session: dict = {}
        self.status = "stopped"
        self.capture: AudioCapture | None = None
        self.transcriber = None
        self.llm: LLMClient | None = None
        self.transcription_provider = DEFAULT_TRANSCRIPTION_PROVIDER
        self.question_settle_seconds = QUESTION_SETTLE_SECONDS
        self.model_fallback = ""
        self.usage = UsageTracker()
        self._usage_broadcast_at = 0.0
        self.audio_queue: queue.Queue[bytes] = queue.Queue(maxsize=512)
        # Bounded: if the answer worker dies, questions must not accumulate
        # without back-pressure or any signal to the user.
        self.answer_queue: queue.Queue[tuple[str, queue.Queue | None]] = queue.Queue(
            maxsize=MAX_PENDING_ANSWERS
        )
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
        deepgram_api_key: str = "",
        history_enabled: bool = False,
        transcription_provider: str = DEFAULT_TRANSCRIPTION_PROVIDER,
    ) -> dict:
        with self.lifecycle_lock:
            return self._start_session_locked(
                resume_text=resume_text,
                extra_context=extra_context,
                language=language,
                model=model,
                api_key=api_key,
                deepgram_api_key=deepgram_api_key,
                history_enabled=history_enabled,
                transcription_provider=transcription_provider,
            )

    def _start_session_locked(
        self,
        *,
        resume_text: str,
        extra_context: str,
        language: str,
        model: str,
        api_key: str,
        deepgram_api_key: str,
        history_enabled: bool,
        transcription_provider: str,
    ) -> dict:
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
            self.transcription_provider = transcription_provider
            self.question_settle_seconds = (
                UTTERANCE_SETTLE_SECONDS
                if transcription_provider in COMPLETE_UTTERANCE_PROVIDERS
                else QUESTION_SETTLE_SECONDS
            )
            self.usage = UsageTracker(
                provider=transcription_provider,
                stt_model=DEFAULT_STT_MODEL,
            )
            self.transcriber = create_transcriber(
                transcription_provider,
                on_transcript=self._on_transcript,
                groq_api_key=api_key,
                deepgram_api_key=deepgram_api_key,
                language=language,
                on_usage=self._on_audio_usage,
                on_activity=self._on_speech_activity,
                on_error=self._on_transcriber_error,
            )
            self.llm = LLMClient(
                api_key=api_key,
                on_usage=self._on_llm_usage,
                on_retry=self._on_llm_retry,
            )
            # Groq retires model IDs, and a saved preference outlives them, so
            # reconcile before the first question rather than failing on it.
            resolution = self.llm.resolve_models(model)
            self.session["model"] = resolution["answer_model"]
            self.model_fallback = resolution["fell_back_from"]

            # Every worker below is bound to the runtime it was started for.
            # Reading self.stop_event / self.audio_queue per iteration instead
            # would let a thread that outlived its session latch onto the next
            # one's fresh (unset) event and keep running.
            stop_event = self.stop_event
            audio_queue = self.audio_queue
            answer_queue = self.answer_queue
            llm = self.llm
            session = dict(self.session)

            self.capture = AudioCapture(
                self._make_audio_sink(runtime_id, stop_event, audio_queue)
            )
            try:
                self.transcriber.start()
                self.worker_thread = threading.Thread(
                    target=self._transcription_loop,
                    args=(runtime_id, stop_event, audio_queue),
                    name=f"wingman-transcribe-{runtime_id}",
                    daemon=True,
                )
                self.worker_thread.start()
                self.answer_worker_thread = threading.Thread(
                    target=self._answer_loop,
                    args=(runtime_id, stop_event, answer_queue, llm, session),
                    name=f"wingman-answer-{runtime_id}",
                    daemon=True,
                )
                self.answer_worker_thread.start()
                self.capture.start()
            except Exception:
                if self.capture is not None:
                    self.capture.stop()
                if self.transcriber is not None:
                    self.transcriber.stop()
                self._close_clients()
                self.runtime_id += 1
                stop_event.set()
                self._reset_runtime()
                raise

        self._broadcast_transcript({"type": "status", "status": "listening"})
        self._broadcast_usage(force=True)
        if self.model_fallback:
            self._broadcast_transcript(
                {
                    "type": "notice",
                    "message": (
                        f"{self.model_fallback} is not available on this API key. "
                        f"Using {self.session['model']} instead."
                    ),
                }
            )

        return {
            "session_id": self.session_id,
            "status": self.status,
            "transcription_provider": self.transcription_provider,
            "model": self.session.get("model", ""),
            "model_fallback": self.model_fallback,
        }

    def stop_session(self) -> dict:
        with self.lifecycle_lock:
            return self._stop_session_locked()

    def _stop_session_locked(self) -> dict:
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

        # Ordering matters. Workers that finished inside the join window above
        # have already recorded their answers, so history is still complete.
        # Anything still running (a Groq read can block for the SDK's full
        # timeout, far past the join) is invalidated here: every worker
        # re-checks runtime_id before it emits, so once this increments a
        # straggler cannot append to the next session's exchanges, broadcast a
        # status onto a stopped session, or keep draining the answer queue.
        if worker is not None or answer_worker is not None:
            leaked = [
                thread.name
                for thread in (worker, answer_worker)
                if thread is not None and thread.is_alive()
            ]
            if leaked:
                log.warning(
                    "Worker(s) outlived stop and were fenced off: %s", ", ".join(leaked)
                )
        self.runtime_id += 1
        self._close_clients()

        if history_enabled:
            session_snapshot = {
                "session_id": session_id,
                "started_at": started_at,
                "exchanges": list(self.exchanges),
            }
            self._save_history(session_snapshot)

        self.status = "stopped"
        # Final spend figure while the tracker is still the session's own.
        final_usage = self._usage_snapshot()
        self._broadcast_transcript({"type": "usage", "usage": final_usage})
        self._broadcast_transcript({"type": "status", "status": "stopped"})
        self._broadcast_answer({"type": "status", "status": "stopped"})
        self._reset_runtime()
        return {"status": "stopped", "usage": final_usage}

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
        subscriber = self._register_subscriber(self.transcript_subscribers)
        return self._yield_queue(subscriber, kind="transcript")

    def subscribe_answers(self) -> Generator[dict, None, None]:
        subscriber = self._register_subscriber(self.answer_subscribers)
        return self._yield_queue(subscriber, kind="answer")

    def _register_subscriber(self, collection: set) -> queue.Queue:
        """Add an SSE subscriber, capped.

        Only two windows subscribe, so hitting the cap means connections are
        leaking. The heartbeat reaps dead ones within 15s; this bounds the
        damage in the meantime, since each subscriber also costs a server thread.
        """
        subscriber: queue.Queue = queue.Queue(maxsize=256)
        with self.subscriber_lock:
            if len(collection) >= MAX_SSE_SUBSCRIBERS:
                raise RuntimeError("Too many open event streams.")
            collection.add(subscriber)
        return subscriber

    def current_usage(self) -> dict:
        return self._usage_snapshot()

    def _history_files(self) -> list[Path]:
        try:
            return sorted(self.history_dir.glob("*.json"), reverse=True)
        except OSError as error:
            log.error("History directory unreadable: %s", error)
            return []

    def list_history(self, limit: int = 50, offset: int = 0) -> dict:
        """One page of stored sessions.

        Previously every file was read and serialised into a single response on
        every call, which grows without bound over a user's lifetime.
        """
        files = self._history_files()
        total = len(files)
        sessions = []
        for file_path in files[offset : offset + limit]:
            try:
                sessions.append(json.loads(file_path.read_text(encoding="utf-8")))
            except (OSError, ValueError) as error:
                # Skipping silently meant a user lost a session with no way to
                # know why it vanished from the list.
                log.warning("Skipping unreadable history file %s: %s", file_path.name, error)
                continue
        return {"sessions": sessions, "total": total}

    def delete_history(self, session_id: str) -> bool:
        """Delete one stored session by ID.

        The ID is matched against parsed filenames rather than interpolated into
        a path, so a traversal sequence cannot escape the history directory.
        """
        wanted = str(session_id).strip()
        if not wanted:
            return False

        for file_path in self._history_files():
            if file_path.stem.split("_", 1)[-1] != wanted:
                continue
            try:
                file_path.unlink()
                return True
            except OSError as error:
                log.error("Could not delete %s: %s", file_path.name, error)
                return False
        return False

    def clear_history(self) -> int:
        removed = 0
        for file_path in self._history_files():
            try:
                file_path.unlink()
                removed += 1
            except OSError as error:
                log.error("Could not delete %s: %s", file_path.name, error)
        return removed

    def _prune_history(self):
        """Keep the newest MAX_HISTORY_SESSIONS records."""
        files = self._history_files()
        for file_path in files[MAX_HISTORY_SESSIONS:]:
            try:
                file_path.unlink()
            except OSError as error:
                log.debug("Could not prune %s: %s", file_path.name, error)

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

    def _make_audio_sink(
        self,
        runtime_id: int,
        stop_event: threading.Event,
        audio_queue: queue.Queue,
    ):
        """Audio callback bound to one runtime.

        The capture backends are callback-driven from a native thread, so a
        frame can land after stop_session has already installed a fresh queue.
        Binding the queue here means a late frame is discarded rather than fed
        into the next session.
        """

        def sink(audio_chunk: bytes):
            if stop_event.is_set() or self.runtime_id != runtime_id:
                return
            try:
                audio_queue.put_nowait(audio_chunk)
            except queue.Full:
                try:
                    audio_queue.get_nowait()
                except queue.Empty:
                    pass
                try:
                    audio_queue.put_nowait(audio_chunk)
                except queue.Full:
                    pass

        return sink

    # ------------------------------------------------------------------
    # Transcription loop
    # ------------------------------------------------------------------

    def _transcription_loop(
        self,
        runtime_id: int,
        stop_event: threading.Event,
        audio_queue: queue.Queue,
    ):
        try:
            while not stop_event.is_set() and self.runtime_id == runtime_id:
                try:
                    audio_chunk = audio_queue.get(timeout=0.25)
                except queue.Empty:
                    self._guarded_flush(runtime_id)
                    continue

                try:
                    self._process_audio_chunk(audio_chunk)
                except Exception as error:
                    log.error("Transcription error: %s", error, exc_info=True)

                self._guarded_flush(runtime_id)

            if self.runtime_id == runtime_id:
                self._guarded_flush(runtime_id, force=True)
        except BaseException as error:  # pragma: no cover - defensive
            log.critical("Transcription loop died: %s", error, exc_info=True)
            if self.runtime_id == runtime_id:
                self._broadcast_transcript(
                    {
                        "type": "error",
                        "message": "Transcription stopped unexpectedly. Restart the session.",
                    }
                )

    def _guarded_flush(self, runtime_id: int, force: bool = False):
        """Flush without letting one failure end transcription for the session."""
        try:
            self._flush_pending_question_if_ready(force=force)
        except Exception as error:
            log.error("Question flush failed: %s", error, exc_info=True)

    def _answer_loop(
        self,
        runtime_id: int,
        stop_event: threading.Event,
        answer_queue: queue.Queue,
        llm: LLMClient | None,
        session: dict,
    ):
        try:
            while True:
                # Both conditions are checked against the captured runtime, not
                # self.stop_event, so this thread can never adopt a later
                # session's queue or event.
                if self.runtime_id != runtime_id:
                    return
                if stop_event.is_set() and answer_queue.empty():
                    return
                try:
                    prompt, local_queue = answer_queue.get(timeout=0.25)
                except queue.Empty:
                    continue

                try:
                    if stop_event.is_set() or self.runtime_id != runtime_id:
                        # Never leave a manual-answer SSE generator hanging on a
                        # `done` that will not arrive.
                        if local_queue is not None:
                            local_queue.put({"type": "done"})
                        continue
                    self._stream_answer_worker(
                        runtime_id, stop_event, llm, session, prompt, local_queue
                    )
                except Exception as error:
                    log.error("Answer worker failed: %s", error, exc_info=True)
                    if local_queue is not None:
                        local_queue.put({"type": "done"})
                finally:
                    answer_queue.task_done()
        except BaseException as error:  # pragma: no cover - defensive
            log.critical("Answer loop died: %s", error, exc_info=True)
            if self.runtime_id == runtime_id:
                self._broadcast_answer(
                    {
                        "type": "error",
                        "message": "Answer generation stopped unexpectedly. Restart the session.",
                    }
                )

    # ------------------------------------------------------------------
    # Audio to transcript
    # ------------------------------------------------------------------

    def _process_audio_chunk(self, audio_chunk: bytes):
        if not self.transcriber:
            return
        self.transcriber.feed(audio_chunk)

    def _on_transcript(self, text: str, is_final: bool):
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

    def _on_speech_activity(self, active: bool):
        """Keeps the overlay responsive while a batch transcript is in flight.

        The Groq provider only produces text once an utterance ends, so without
        this the UI would sit on "listening" through the whole question.
        """
        if self.stop_event.is_set() or not self.session_id:
            return

        if active:
            self.status = "transcribing"
            self._broadcast_transcript({"type": "status", "status": "transcribing"})

    def _on_transcriber_error(self, message: str):
        self._broadcast_transcript({"type": "error", "message": message})

    # ------------------------------------------------------------------
    # Usage accounting
    # ------------------------------------------------------------------

    def _on_audio_usage(self, seconds: float):
        self.usage.record_audio(seconds)

    def _on_llm_retry(self, reason: str, wait_seconds: float):
        detail = (
            f"{reason}. Retrying in {wait_seconds:.0f}s."
            if wait_seconds >= 1
            else f"{reason}."
        )
        self._broadcast_transcript({"type": "notice", "message": detail})

    def _on_llm_usage(self, model: str, prompt_tokens: int, completion_tokens: int):
        self.usage.record_llm(
            model,
            input_tokens=prompt_tokens,
            output_tokens=completion_tokens,
        )

    def _usage_snapshot(self) -> dict:
        # Deepgram bills for the time the socket is open, so its running total
        # is wall clock rather than the speech the VAD measured.
        if self.transcription_provider == "deepgram" and self.started_at:
            self.usage.set_stream_seconds(time.time() - self.started_at)
        return self.usage.snapshot()

    def _broadcast_usage(self, force: bool = False):
        now = time.time()
        if not force and (now - self._usage_broadcast_at) < USAGE_BROADCAST_INTERVAL_SECONDS:
            return

        self._usage_broadcast_at = now
        self._broadcast_transcript({"type": "usage", "usage": self._usage_snapshot()})

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
        # The heuristics are English keyword lists, so in another language their
        # silence is not evidence of anything. Buffer the utterance anyway and
        # let the classifier decide.
        needs_classifier = self._needs_classifier(normalized)

        if self.pending_question_segments and has_answer_lead_in:
            log.debug("Answer lead-in, early flush: %s", redact(normalized))
            self._flush_pending_question_if_ready(force=True)
            self.pending_utterance_segments.append(normalized)
        elif (
            has_question_signal
            or has_prompt_signal
            or needs_classifier
            or self.pending_question_segments
        ):
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
        self._broadcast_usage()

    def _flush_pending_question_if_ready(self, force: bool = False):
        if not self.pending_question_segments:
            return

        if not force and (time.time() - self.last_transcript_at) < self.question_settle_seconds:
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
            or self._needs_classifier(question)
        ):
            log.debug("No question signal, skipping classifier: %s", redact(question))
            self._go_listening()
            return

        if question == self._last_enqueued_question:
            log.debug("Duplicate question, skipping")
            self._go_listening()
            return

        if self._looks_like_direct_question(segments, question):
            log.info("Direct question, enqueueing: %s", redact(question))
            self._enqueue_question(question)
            return

        log.info("Classifying: %s", redact(question))
        # A non-English session sends most utterances here, so an unbounded
        # thread-per-flush becomes thread-per-utterance the moment Groq stalls.
        if not self._classifier_slots.acquire(blocking=False):
            log.warning("Classifier saturated, assuming question: %s", redact(question))
            self._enqueue_question(question)
            return

        threading.Thread(
            target=self._classify_and_enqueue,
            args=(question, self.runtime_id, self.stop_event, self.llm),
            name="wingman-classify",
            daemon=True,
        ).start()

    def _classify_and_enqueue(
        self,
        question: str,
        runtime_id: int,
        stop_event: threading.Event,
        llm: LLMClient | None,
    ):
        try:
            if stop_event.is_set() or self.runtime_id != runtime_id:
                return

            try:
                is_question = llm.is_question(question) if llm else False
            except Exception as error:
                log.warning("Classifier failed, assuming yes: %s", error)
                is_question = True

            if stop_event.is_set() or self.runtime_id != runtime_id:
                return

            if not is_question:
                log.info("Classifier says not a question: %s", redact(question))
                self._go_listening()
                return

            log.info("Question confirmed: %s", redact(question))
            self._enqueue_question(question)
        finally:
            self._classifier_slots.release()

    def _enqueue_question(self, question: str):
        self._recent_context.clear()
        self.pending_utterance_segments = []
        self._last_enqueued_question = question
        try:
            self.answer_queue.put_nowait((question, None))
        except queue.Full:
            # The answer worker is wedged or Groq is stalling. Say so instead of
            # queueing an answer nobody will see in time.
            log.warning("Answer queue full, dropping question %s", redact(question))
            self._broadcast_transcript(
                {
                    "type": "notice",
                    "message": "Still answering the previous question — this one was skipped.",
                }
            )

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
            if is_rate_limit(error):
                fallback = (
                    "Groq is rate limiting this API key right now. "
                    "Wait a few seconds, then ask again."
                )
            else:
                fallback = "I lost the answer stream. Please ask the question again."
            log.error("Answer generation failed: %s", error, exc_info=True)
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
            self._broadcast_usage(force=True)
        elif local_queue is not None:
            # `fan` suppresses everything once the runtime moves on, but a
            # manual-answer SSE generator terminates on `done` and would
            # otherwise hang until the client gives up.
            local_queue.put({"type": "done"})

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

    def _is_english_session(self) -> bool:
        return str(self.session.get("language", "en")).strip().lower().startswith("en")

    def _needs_classifier(self, text: str) -> bool:
        """Whether an utterance with no English signal still deserves a look.

        Every heuristic in this module is an English keyword list, so for a
        Spanish or Hindi interview they can only ever produce false negatives:
        "¿qué es...?" is caught by the question mark, but an imperative like
        "cuéntame sobre..." matches nothing and would be silently dropped.

        Rather than hand-maintain prefix lists per language, spend a classifier
        call. It runs on the cheap model at roughly 36 completion tokens, about
        $0.00002 - far below the cost of missing the question. Bounds keep it
        from firing on back-channel noise or a full monologue.
        """
        if self._is_english_session():
            return False

        words = text.split()
        return MIN_CLASSIFIER_WORDS <= len(words) <= MAX_CLASSIFIER_WORDS

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
        try:
            file_path.write_text(json.dumps(record, indent=2), encoding="utf-8")
            # The most sensitive thing this app writes: a verbatim, unencrypted
            # record of the questions asked and the answers given. Default file
            # creation leaves it world-readable on POSIX.
            restrict_permissions(file_path, 0o600)
        except OSError as error:
            log.error("Could not write history for %s: %s", session_id, error)
            self._broadcast_transcript(
                {"type": "notice", "message": "This session could not be saved to history."}
            )
            return

        self._prune_history()
