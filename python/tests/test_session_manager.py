# Copyright (c) 2026 Sarthak Parulekar
# SPDX-License-Identifier: MIT

from __future__ import annotations

import queue
import sys
import time
import tempfile
import threading
import unittest
from pathlib import Path

import numpy as np

PYTHON_DIR = Path(__file__).resolve().parents[1]
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

import session_manager
from session_manager import SessionManager


class FakeLLM:
    def is_question(self, transcript: str) -> bool:
        return transcript.lower().startswith("what")


class PromptDrivenLLM:
    def is_question(self, transcript: str) -> bool:
        return transcript.lower().startswith("please share")


class NeverClassifierLLM:
    def is_question(self, transcript: str) -> bool:
        raise AssertionError("Classifier should not run for obvious interview questions")


class ExplodingClassifierLLM:
    def is_question(self, transcript: str) -> bool:
        raise AssertionError("Classifier should not run for non-question chatter")


class BlockingAnswerLLM:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()

    def stream_answer(self, question: str, session: dict):
        self.started.set()
        self.release.wait(timeout=2.0)
        yield "stale token"


class FakeTranscriber:
    def __init__(self, on_transcript):
        self.on_transcript = on_transcript
        self.started = False
        self.stopped = False
        self.feed_chunks: list[bytes] = []

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True

    def feed(self, audio_chunk: bytes):
        self.feed_chunks.append(audio_chunk)


class SessionManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.manager = SessionManager(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_answer_subscriber_stays_open_after_done(self):
        subscriber: queue.Queue = queue.Queue()
        stream = self.manager._yield_queue(subscriber, kind="answer")

        self.assertEqual(next(stream), {"type": "status", "status": "stopped"})

        subscriber.put({"type": "done"})
        self.assertEqual(next(stream), {"type": "done"})

        subscriber.put({"type": "status", "status": "thinking"})
        self.assertEqual(next(stream), {"type": "status", "status": "thinking"})

        stream.close()

    def test_local_stream_closes_after_done(self):
        subscriber: queue.Queue = queue.Queue()
        stream = self.manager._yield_queue(subscriber, close_on_done=True)

        subscriber.put({"type": "done"})
        self.assertEqual(next(stream), {"type": "done"})

        with self.assertRaises(StopIteration):
            next(stream)

    def test_final_transcript_queues_detected_question(self):
        self.manager.llm = FakeLLM()
        self.manager.transcriber = FakeTranscriber(self.manager._on_transcript)

        self.manager._on_transcript("What is React", is_final=True)
        self.manager._flush_pending_question_if_ready(force=True)

        question, local_queue = self.manager.answer_queue.get_nowait()
        self.assertEqual(question, "What is React")
        self.assertIsNone(local_queue)

    def test_interim_transcript_does_not_queue_question(self):
        self.manager.llm = FakeLLM()
        subscriber: queue.Queue = queue.Queue()
        self.manager.transcript_subscribers.add(subscriber)

        self.manager._on_transcript("What is React", is_final=False)

        payload = subscriber.get_nowait()
        self.assertEqual(
            payload,
            {
                "type": "transcript",
                "text": "What is React",
                "interim": True,
                "is_question": False,
            },
        )
        with self.assertRaises(queue.Empty):
            self.manager.answer_queue.get_nowait()

    def test_long_utterance_without_keyword_still_gets_classified(self):
        self.manager.llm = PromptDrivenLLM()

        self.manager._publish_transcript("Please share one production incident you solved")
        self.manager._flush_pending_question_if_ready(force=True)

        question, local_queue = self.manager.answer_queue.get_nowait()
        self.assertEqual(question, "Please share one production incident you solved")
        self.assertIsNone(local_queue)

    def test_obvious_question_bypasses_classifier_round_trip(self):
        self.manager.llm = NeverClassifierLLM()

        self.manager._publish_transcript("How would you optimize this query")
        self.manager._flush_pending_question_if_ready(force=True)

        question, local_queue = self.manager.answer_queue.get_nowait()
        self.assertEqual(question, "How would you optimize this query")
        self.assertIsNone(local_queue)

    def test_prompt_style_question_bypasses_classifier_round_trip(self):
        self.manager.llm = NeverClassifierLLM()

        self.manager._publish_transcript("Please share one production incident you solved")
        self.manager._flush_pending_question_if_ready(force=True)

        question, local_queue = self.manager.answer_queue.get_nowait()
        self.assertEqual(question, "Please share one production incident you solved")
        self.assertIsNone(local_queue)

    def test_trailing_courtesy_is_removed_from_detected_question(self):
        self.manager.llm = FakeLLM()

        self.manager._publish_transcript("What is React")
        self.manager._publish_transcript("Thank you")
        self.manager._flush_pending_question_if_ready(force=True)

        question, local_queue = self.manager.answer_queue.get_nowait()
        self.assertEqual(question, "What is React")
        self.assertIsNone(local_queue)

    def test_answer_lead_in_flushes_question_before_candidate_response(self):
        self.manager.llm = FakeLLM()

        self.manager._publish_transcript("What is React")
        self.manager._publish_transcript("Sure I used it on a dashboard migration")

        question, local_queue = self.manager.answer_queue.get_nowait()
        self.assertEqual(question, "What is React")
        self.assertIsNone(local_queue)
        self.assertEqual(
            self.manager.pending_utterance_segments,
            ["Sure I used it on a dashboard migration"],
        )

    def test_long_non_question_chatter_is_not_sent_to_classifier(self):
        self.manager.llm = ExplodingClassifierLLM()

        self.manager._publish_transcript("Thank you so much for joining us today everyone")
        self.manager._flush_pending_question_if_ready(force=True)

        with self.assertRaises(queue.Empty):
            self.manager.answer_queue.get_nowait()

    def test_stale_answer_worker_does_not_emit_after_stop(self):
        llm = BlockingAnswerLLM()
        subscriber: queue.Queue = queue.Queue()
        self.manager.answer_subscribers.add(subscriber)
        self.manager.llm = llm
        self.manager.session = {"resume_text": "", "extra_context": ""}
        self.manager.runtime_id = 1

        worker = threading.Thread(
            target=self.manager._stream_answer_worker,
            args=(1, self.manager.stop_event, llm, dict(self.manager.session), "Old question", None),
            daemon=True,
        )
        worker.start()

        self.assertEqual(
            subscriber.get(timeout=1.0),
            {"type": "status", "status": "thinking"},
        )
        self.assertTrue(llm.started.wait(timeout=1.0))

        stale_stop_event = self.manager.stop_event
        stale_stop_event.set()
        self.manager.runtime_id = 2
        self.manager.stop_event = threading.Event()
        llm.release.set()

        worker.join(timeout=1.0)
        self.assertFalse(worker.is_alive())
        self.assertTrue(subscriber.empty())
        self.assertEqual(self.manager.exchanges, [])

    def test_quiet_speech_still_reaches_transcriber(self):
        self.manager.transcriber = FakeTranscriber(self.manager._on_transcript)

        quiet_chunk = (np.ones(1024, dtype=np.int16) * 60).tobytes()
        self.manager._process_audio_chunk(quiet_chunk)

        self.assertGreater(len(self.manager.transcriber.feed_chunks), 0)


class SettleWindowTests(unittest.TestCase):
    """The settle window is pure latency for providers that never fragment."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.manager = SessionManager(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_default_is_the_conservative_window(self):
        self.assertEqual(
            self.manager.question_settle_seconds,
            session_manager.QUESTION_SETTLE_SECONDS,
        )

    def test_a_complete_utterance_provider_barely_waits(self):
        self.manager.transcription_provider = "groq"
        self.manager.question_settle_seconds = session_manager.UTTERANCE_SETTLE_SECONDS
        self.manager.llm = FakeLLM()

        self.manager._publish_transcript("What is React")
        time.sleep(session_manager.UTTERANCE_SETTLE_SECONDS + 0.02)
        self.manager._flush_pending_question_if_ready()

        question, _ = self.manager.answer_queue.get_nowait()
        self.assertEqual(question, "What is React")

    def test_a_fragmenting_provider_still_holds_the_question(self):
        self.manager.transcription_provider = "deepgram"
        self.manager.question_settle_seconds = session_manager.QUESTION_SETTLE_SECONDS
        self.manager.llm = FakeLLM()

        self.manager._publish_transcript("What is React")
        # Well inside the window, so the question must not be released yet.
        self.manager._flush_pending_question_if_ready()

        with self.assertRaises(queue.Empty):
            self.manager.answer_queue.get_nowait()

    def test_the_fast_window_is_meaningfully_faster(self):
        self.assertLess(
            session_manager.UTTERANCE_SETTLE_SECONDS,
            session_manager.QUESTION_SETTLE_SECONDS / 4,
        )



class MultilingualDetectionTests(unittest.TestCase):
    """English keyword lists cannot speak for other languages.

    In a non-English session their silence is a false negative, so the
    classifier is consulted instead of dropping the utterance.
    """

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.manager = SessionManager(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def _session(self, language):
        self.manager.session = {
            "resume_text": "",
            "extra_context": "",
            "language": language,
            "model": "openai/gpt-oss-120b",
        }

    def test_english_sessions_never_take_the_extra_call(self):
        self._session("en")

        self.assertFalse(
            self.manager._needs_classifier("Muchas gracias por acompanarnos hoy")
        )

    def test_a_missing_language_is_treated_as_english(self):
        self.manager.session = {}

        self.assertFalse(self.manager._needs_classifier("cuentame sobre tu experiencia"))

    def test_non_english_imperatives_reach_the_classifier(self):
        self._session("es")
        self.manager.llm = FakeLLM()

        # No question mark and no English keyword: previously dropped outright.
        self.manager._publish_transcript("Cuentame sobre un problema que resolviste")

        self.assertTrue(self.manager._needs_classifier("Cuentame sobre un problema"))
        self.assertEqual(
            self.manager.pending_question_segments,
            ["Cuentame sobre un problema que resolviste"],
        )

    def test_a_punctuated_question_still_skips_the_classifier(self):
        """The question mark is language-agnostic, so it stays the fast path."""
        self._session("es")
        self.manager.llm = NeverClassifierLLM()

        self.manager._publish_transcript("Que es un decorador en Python?")
        self.manager._flush_pending_question_if_ready(force=True)

        question, _ = self.manager.answer_queue.get_nowait()
        self.assertEqual(question, "Que es un decorador en Python?")

    def test_back_channel_noise_is_too_short_to_be_worth_a_call(self):
        self._session("es")

        for noise in ("si", "vale", "de acuerdo"):
            self.assertFalse(self.manager._needs_classifier(noise), noise)

    def test_a_monologue_is_too_long_to_be_worth_a_call(self):
        self._session("es")

        monologue = " ".join(["palabra"] * (session_manager.MAX_CLASSIFIER_WORDS + 5))

        self.assertFalse(self.manager._needs_classifier(monologue))

    def test_the_bounds_admit_a_normal_interview_prompt(self):
        self._session("fr")

        self.assertTrue(
            self.manager._needs_classifier(
                "Parlez-moi d une panne que vous avez geree recemment"
            )
        )


class RuntimeFencingTests(unittest.TestCase):
    """The worker *loops*, not just the inner workers, must respect the runtime.

    The inner functions always re-checked runtime_id, but the two long-lived
    loops read ``self.stop_event`` and ``self.answer_queue`` on every iteration.
    Because ``_reset_runtime`` installs a *fresh, unset* event and fresh queues,
    a loop that outlived its session (a stalled Groq read can block far past
    stop_session's 2s join) would see the new session's unset event, keep
    running, and race the live worker for the same questions — two Groq streams
    interleaved token-by-token into one SSE connection, at double cost.
    """

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.manager = SessionManager(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_stop_session_advances_the_runtime(self):
        """This is what fences off a worker that outlived its join timeout."""
        before = self.manager.runtime_id

        self.manager.stop_session()

        self.assertGreater(self.manager.runtime_id, before)

    def test_answer_loop_exits_when_the_runtime_advances(self):
        stop_event = self.manager.stop_event
        answer_queue = self.manager.answer_queue
        runtime_id = self.manager.runtime_id

        worker = threading.Thread(
            target=self.manager._answer_loop,
            args=(runtime_id, stop_event, answer_queue, FakeLLM(), {}),
            daemon=True,
        )
        worker.start()

        # Exactly what stop_session does to a worker it could not join.
        self.manager.runtime_id += 1

        worker.join(timeout=2.0)
        self.assertFalse(worker.is_alive(), "answer loop adopted the next runtime")

    def test_a_leaked_answer_loop_does_not_consume_the_next_sessions_questions(self):
        stale_stop_event = self.manager.stop_event
        stale_queue = self.manager.answer_queue
        stale_runtime = self.manager.runtime_id

        worker = threading.Thread(
            target=self.manager._answer_loop,
            args=(stale_runtime, stale_stop_event, stale_queue, FakeLLM(), {}),
            daemon=True,
        )
        worker.start()

        # A new session: fresh runtime, fresh unset event, fresh queue.
        self.manager.runtime_id += 1
        self.manager._reset_runtime()
        worker.join(timeout=2.0)
        self.assertFalse(worker.is_alive())

        self.manager.answer_queue.put_nowait(("New session question", None))
        time.sleep(0.4)

        # The straggler must not have drained it.
        self.assertEqual(
            self.manager.answer_queue.get_nowait(), ("New session question", None)
        )

    def test_transcription_loop_exits_when_the_runtime_advances(self):
        stop_event = self.manager.stop_event
        audio_queue = self.manager.audio_queue
        runtime_id = self.manager.runtime_id

        worker = threading.Thread(
            target=self.manager._transcription_loop,
            args=(runtime_id, stop_event, audio_queue),
            daemon=True,
        )
        worker.start()

        self.manager.runtime_id += 1

        worker.join(timeout=2.0)
        self.assertFalse(worker.is_alive(), "transcription loop adopted the next runtime")

    def test_audio_from_a_stopped_session_is_dropped(self):
        runtime_id = self.manager.runtime_id
        audio_queue = self.manager.audio_queue
        sink = self.manager._make_audio_sink(
            runtime_id, self.manager.stop_event, audio_queue
        )

        sink(b"\x00\x01")
        self.assertEqual(audio_queue.qsize(), 1)

        # A native capture callback can fire after the session is torn down.
        self.manager.runtime_id += 1
        sink(b"\x02\x03")

        self.assertEqual(audio_queue.qsize(), 1)

    def test_a_dropped_manual_answer_still_terminates_its_stream(self):
        """A manual-answer SSE generator ends on `done` and would otherwise hang."""
        stop_event = self.manager.stop_event
        answer_queue = self.manager.answer_queue
        runtime_id = self.manager.runtime_id
        local_queue: queue.Queue = queue.Queue()

        stop_event.set()
        answer_queue.put_nowait(("Dropped prompt", local_queue))

        self.manager._answer_loop(runtime_id, stop_event, answer_queue, FakeLLM(), {})

        self.assertEqual(local_queue.get_nowait(), {"type": "done"})

    def test_a_full_answer_queue_notifies_instead_of_growing(self):
        subscriber: queue.Queue = queue.Queue()
        self.manager.transcript_subscribers.add(subscriber)

        for index in range(session_manager.MAX_PENDING_ANSWERS):
            self.manager.answer_queue.put_nowait((f"q{index}", None))

        self.manager._enqueue_question("one too many")

        self.assertEqual(
            self.manager.answer_queue.qsize(), session_manager.MAX_PENDING_ANSWERS
        )
        messages = []
        while True:
            try:
                event = subscriber.get_nowait()
            except queue.Empty:
                break
            if event.get("type") == "notice":
                messages.append(event.get("message", ""))

        self.assertTrue(
            any("skipped" in message for message in messages),
            "a dropped question must be reported, not silently lost",
        )

    def test_subscribers_are_capped(self):
        for _ in range(session_manager.MAX_SSE_SUBSCRIBERS):
            self.manager._register_subscriber(self.manager.transcript_subscribers)

        with self.assertRaises(RuntimeError):
            self.manager._register_subscriber(self.manager.transcript_subscribers)


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.manager = SessionManager(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def _write(self, session_id: str):
        self.manager._save_history(
            {
                "session_id": session_id,
                "started_at": time.time(),
                "exchanges": [{"question": "q", "answer": "a", "timestamp": "t"}],
            }
        )

    def test_history_is_paginated(self):
        for index in range(5):
            self._write(f"session-{index}")

        page = self.manager.list_history(limit=2, offset=0)

        self.assertEqual(page["total"], 5)
        self.assertEqual(len(page["sessions"]), 2)

    def test_a_single_session_can_be_deleted(self):
        self._write("keep-me")
        self._write("delete-me")

        self.assertTrue(self.manager.delete_history("delete-me"))

        remaining = {s["session_id"] for s in self.manager.list_history()["sessions"]}
        self.assertEqual(remaining, {"keep-me"})

    def test_deleting_an_unknown_session_reports_failure(self):
        self.assertFalse(self.manager.delete_history("never-existed"))

    def test_a_traversal_sequence_cannot_escape_the_history_directory(self):
        outside = Path(self.temp_dir.name).parent / "wingman-traversal-probe.json"
        outside.write_text("{}", encoding="utf-8")
        try:
            self.assertFalse(self.manager.delete_history("../wingman-traversal-probe"))
            self.assertTrue(outside.exists())
        finally:
            outside.unlink(missing_ok=True)

    def test_history_can_be_cleared(self):
        for index in range(3):
            self._write(f"session-{index}")

        self.assertEqual(self.manager.clear_history(), 3)
        self.assertEqual(self.manager.list_history()["total"], 0)


if __name__ == "__main__":
    unittest.main()
