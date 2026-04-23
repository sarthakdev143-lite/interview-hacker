from __future__ import annotations

import queue
import sys
import tempfile
import threading
import unittest
from pathlib import Path

import numpy as np

PYTHON_DIR = Path(__file__).resolve().parents[1]
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

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

    def test_final_deepgram_transcript_queues_detected_question(self):
        self.manager.llm = FakeLLM()
        self.manager.transcriber = FakeTranscriber(self.manager._on_deepgram_transcript)

        self.manager._on_deepgram_transcript("What is React", is_final=True)
        self.manager._flush_pending_question_if_ready(force=True)

        question, local_queue = self.manager.answer_queue.get_nowait()
        self.assertEqual(question, "What is React")
        self.assertIsNone(local_queue)

    def test_interim_deepgram_transcript_does_not_queue_question(self):
        self.manager.llm = FakeLLM()
        subscriber: queue.Queue = queue.Queue()
        self.manager.transcript_subscribers.add(subscriber)

        self.manager._on_deepgram_transcript("What is React", is_final=False)

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
        self.manager.transcriber = FakeTranscriber(self.manager._on_deepgram_transcript)

        quiet_chunk = (np.ones(1024, dtype=np.int16) * 60).tobytes()
        self.manager._process_audio_chunk(quiet_chunk)

        self.assertGreater(len(self.manager.transcriber.feed_chunks), 0)


if __name__ == "__main__":
    unittest.main()
