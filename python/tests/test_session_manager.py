from __future__ import annotations

import queue
import sys
import tempfile
import time
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


class FakeTranscriber:
    def __init__(self, flush_text: str):
        self.flush_text = flush_text
        self.buffered = False

    def feed(self, _audio_chunk: bytes):
        self.buffered = True
        return None

    def flush(self):
        self.buffered = False
        return self.flush_text

    def has_buffered_audio(self) -> bool:
        return self.buffered


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

    def test_silence_flush_queues_detected_question(self):
        self.manager.llm = FakeLLM()
        self.manager.transcriber = FakeTranscriber("What is React")

        loud_chunk = (np.ones(1024, dtype=np.int16) * 2000).tobytes()
        self.manager._process_audio_chunk(loud_chunk)

        self.manager.last_voice_activity_at = time.time() - 1.0
        self.manager._flush_transcriber_if_ready()
        self.manager._flush_pending_question_if_ready(force=True)

        question, local_queue = self.manager.answer_queue.get_nowait()
        self.assertEqual(question, "What is React")
        self.assertIsNone(local_queue)


if __name__ == "__main__":
    unittest.main()
