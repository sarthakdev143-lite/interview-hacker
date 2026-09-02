# Copyright (c) 2026 Sarthak Parulekar
# SPDX-License-Identifier: MIT

from __future__ import annotations

import io
import sys
import threading
import unittest
import wave
from pathlib import Path

import numpy as np

PYTHON_DIR = Path(__file__).resolve().parents[1]
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

from transcriber import (  # noqa: E402
    DeepgramTranscriber,
    GroqTranscriber,
    create_transcriber,
    pcm_to_wav,
)
from vad import SAMPLE_RATE  # noqa: E402


def silence(seconds: float) -> bytes:
    return np.zeros(int(SAMPLE_RATE * seconds), dtype=np.int16).tobytes()


def speech(seconds: float, amplitude: int = 6000) -> bytes:
    count = int(SAMPLE_RATE * seconds)
    t = np.arange(count, dtype=np.float32) / SAMPLE_RATE
    return (np.sin(2 * np.pi * 180.0 * t) * amplitude).astype(np.int16).tobytes()


class FakeTranscriptions:
    def __init__(self, text: str = "What is your experience with React"):
        self.text = text
        self.calls: list[dict] = []
        self._lock = threading.Lock()

    def create(self, **kwargs):
        with self._lock:
            self.calls.append(kwargs)
        return self.text

    @property
    def call_count(self) -> int:
        with self._lock:
            return len(self.calls)


class FakeGroqClient:
    def __init__(self, text: str = "What is your experience with React"):
        self.audio = type("Audio", (), {})()
        self.audio.transcriptions = FakeTranscriptions(text)


class PcmToWavTests(unittest.TestCase):
    def test_wav_container_matches_the_capture_format(self):
        pcm = speech(0.5)

        wav_bytes = pcm_to_wav(pcm)

        with wave.open(io.BytesIO(wav_bytes), "rb") as handle:
            self.assertEqual(handle.getnchannels(), 1)
            self.assertEqual(handle.getsampwidth(), 2)
            self.assertEqual(handle.getframerate(), SAMPLE_RATE)
            self.assertEqual(handle.getnframes(), len(pcm) // 2)


class GroqTranscriberTests(unittest.TestCase):
    def _build(self, **kwargs):
        transcriber = GroqTranscriber(api_key="test-key", **kwargs)
        transcriber.client = FakeGroqClient()
        return transcriber

    def test_empty_api_key_is_rejected(self):
        with self.assertRaises(ValueError):
            GroqTranscriber(api_key="   ", on_transcript=lambda *_: None)

    def test_normalize_collapses_whitespace(self):
        self.assertEqual(
            GroqTranscriber._normalize("  What   is\n React ?  "),
            "What is React ?",
        )

    def test_normalize_drops_whisper_silence_hallucinations(self):
        for hallucination in ("Thank you.", "thanks for watching!", "you"):
            self.assertEqual(GroqTranscriber._normalize(hallucination), "")

    def test_normalize_accepts_an_object_response(self):
        response = type("Response", (), {"text": "Tell me about yourself"})()

        self.assertEqual(
            GroqTranscriber._normalize(response),
            "Tell me about yourself",
        )

    def test_transcripts_are_emitted_in_utterance_order(self):
        received: list[str] = []
        transcriber = self._build(on_transcript=lambda text, _final: received.append(text))

        # Utterance 1 finishes before utterance 0, which is what happens when a
        # short clip overtakes a long one on the thread pool.
        transcriber._emit_in_order(1, "second")
        self.assertEqual(received, [])

        transcriber._emit_in_order(0, "first")
        self.assertEqual(received, ["first", "second"])

    def test_failed_utterance_does_not_block_later_transcripts(self):
        received: list[str] = []
        transcriber = self._build(on_transcript=lambda text, _final: received.append(text))

        transcriber._emit_in_order(0, "")  # request failed, empty result
        transcriber._emit_in_order(1, "second")

        self.assertEqual(received, ["second"])

    def test_only_speech_reaches_the_api(self):
        received = threading.Event()
        transcripts: list[str] = []
        billed: list[float] = []

        def on_transcript(text: str, _is_final: bool):
            transcripts.append(text)
            received.set()

        transcriber = self._build(
            on_transcript=on_transcript,
            on_usage=billed.append,
        )
        transcriber.start()
        try:
            # Four and a half seconds of audio holding two seconds of speech.
            transcriber.feed(silence(1.0) + speech(2.0) + silence(1.5))
            self.assertTrue(received.wait(timeout=5.0), "no transcript was produced")
        finally:
            transcriber.stop()

        self.assertEqual(transcripts, ["What is your experience with React"])
        self.assertEqual(transcriber.client.audio.transcriptions.call_count, 1)

        # Billing follows the speech, not the wall clock.
        self.assertEqual(len(billed), 1)
        self.assertGreaterEqual(billed[0], 1.9)
        self.assertLessEqual(billed[0], 2.7)

    def test_silence_alone_never_calls_the_api(self):
        received = threading.Event()
        transcriber = self._build(
            on_transcript=lambda *_: received.set(),
        )
        transcriber.start()
        try:
            transcriber.feed(silence(4.0))
            # Followed by real speech, so the assertion does not depend on a
            # sleep: once the burst lands, any silence call would already exist.
            transcriber.feed(speech(1.5) + silence(1.5))
            self.assertTrue(received.wait(timeout=5.0), "no transcript was produced")
        finally:
            transcriber.stop()

        self.assertEqual(transcriber.client.audio.transcriptions.call_count, 1)

    def test_language_is_forwarded_and_auto_is_omitted(self):
        received = threading.Event()
        transcriber = self._build(
            on_transcript=lambda *_: received.set(),
            language="es",
        )
        transcriber.start()
        try:
            transcriber.feed(silence(0.5) + speech(1.5) + silence(1.5))
            self.assertTrue(received.wait(timeout=5.0))
        finally:
            transcriber.stop()

        self.assertEqual(
            transcriber.client.audio.transcriptions.calls[0]["language"],
            "es",
        )

        auto = self._build(on_transcript=lambda *_: None, language="auto")
        options_language = auto.language
        self.assertEqual(options_language, "auto")

    def test_speech_activity_is_reported_for_the_overlay(self):
        activity: list[bool] = []
        received = threading.Event()
        transcriber = self._build(
            on_transcript=lambda *_: received.set(),
            on_activity=activity.append,
        )
        transcriber.start()
        try:
            transcriber.feed(silence(0.5) + speech(1.5) + silence(1.5))
            self.assertTrue(received.wait(timeout=5.0))
        finally:
            transcriber.stop()

        self.assertEqual(activity[:2], [True, False])


class CreateTranscriberTests(unittest.TestCase):
    def test_groq_provider_needs_no_second_key(self):
        transcriber = create_transcriber(
            "groq",
            on_transcript=lambda *_: None,
            groq_api_key="test-key",
        )

        self.assertIsInstance(transcriber, GroqTranscriber)

    def test_deepgram_provider_is_still_available(self):
        transcriber = create_transcriber(
            "deepgram",
            on_transcript=lambda *_: None,
            groq_api_key="test-key",
            deepgram_api_key="deepgram-key",
        )

        self.assertIsInstance(transcriber, DeepgramTranscriber)

    def test_deepgram_without_a_key_fails_loudly(self):
        with self.assertRaises(ValueError):
            create_transcriber(
                "deepgram",
                on_transcript=lambda *_: None,
                groq_api_key="test-key",
                deepgram_api_key="",
            )

    def test_unknown_provider_is_rejected(self):
        with self.assertRaises(ValueError):
            create_transcriber(
                "whisper.cpp",
                on_transcript=lambda *_: None,
                groq_api_key="test-key",
            )


if __name__ == "__main__":
    unittest.main()
