from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

PYTHON_DIR = Path(__file__).resolve().parents[1]
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

from vad import (  # noqa: E402
    FRAME_SAMPLES,
    FRAME_SECONDS,
    MAX_UTTERANCE_FRAMES,
    SAMPLE_RATE,
    UtteranceSegmenter,
)


def silence(seconds: float, amplitude: int = 0) -> bytes:
    count = int(SAMPLE_RATE * seconds)
    if amplitude == 0:
        return np.zeros(count, dtype=np.int16).tobytes()

    generator = np.random.default_rng(1234)
    noise = generator.integers(-amplitude, amplitude + 1, size=count, dtype=np.int16)
    return noise.tobytes()


def speech(seconds: float, amplitude: int = 6000) -> bytes:
    """A loud tone. Only the energy envelope matters to the detector."""
    count = int(SAMPLE_RATE * seconds)
    t = np.arange(count, dtype=np.float32) / SAMPLE_RATE
    wave = np.sin(2 * np.pi * 180.0 * t) * amplitude
    return wave.astype(np.int16).tobytes()


class UtteranceSegmenterTests(unittest.TestCase):
    def test_silence_never_produces_an_utterance(self):
        segmenter = UtteranceSegmenter()

        completed = segmenter.push(silence(5.0))

        self.assertEqual(completed, [])
        self.assertIsNone(segmenter.flush())
        self.assertEqual(segmenter.speech_seconds, 0.0)

    def test_room_tone_never_produces_an_utterance(self):
        segmenter = UtteranceSegmenter()

        completed = segmenter.push(silence(5.0, amplitude=25))

        self.assertEqual(completed, [])
        self.assertEqual(segmenter.speech_seconds, 0.0)

    def test_single_burst_yields_one_utterance(self):
        segmenter = UtteranceSegmenter()

        completed = segmenter.push(silence(1.0) + speech(2.0) + silence(1.5))

        self.assertEqual(len(completed), 1)
        utterance = completed[0]
        # Pre-roll and the retained tail widen the clip slightly beyond 2 s.
        self.assertGreaterEqual(utterance.seconds, 1.9)
        self.assertLessEqual(utterance.seconds, 2.7)
        self.assertEqual(len(utterance.pcm), int(utterance.seconds * SAMPLE_RATE) * 2)

    def test_two_bursts_separated_by_a_long_pause_split(self):
        segmenter = UtteranceSegmenter()

        completed = segmenter.push(
            silence(0.5) + speech(1.5) + silence(1.5) + speech(1.5) + silence(1.5)
        )

        self.assertEqual(len(completed), 2)

    def test_short_pause_inside_one_question_does_not_split(self):
        segmenter = UtteranceSegmenter()

        # 300 ms is under the hangover, so this stays a single question.
        completed = segmenter.push(
            silence(0.5) + speech(1.2) + silence(0.3) + speech(1.2) + silence(1.5)
        )

        self.assertEqual(len(completed), 1)

    def test_blip_shorter_than_the_minimum_is_dropped(self):
        segmenter = UtteranceSegmenter()

        completed = segmenter.push(silence(0.5) + speech(0.15) + silence(1.5))

        self.assertEqual(completed, [])
        self.assertEqual(segmenter.speech_seconds, 0.0)

    def test_long_monologue_is_capped_and_stays_open(self):
        segmenter = UtteranceSegmenter()

        completed = segmenter.push(silence(0.5) + speech(30.0))

        self.assertGreaterEqual(len(completed), 1)
        cap_seconds = MAX_UTTERANCE_FRAMES * FRAME_SECONDS
        self.assertAlmostEqual(completed[0].seconds, cap_seconds, places=3)
        self.assertTrue(segmenter.is_speaking)

    def test_flush_closes_an_open_utterance(self):
        segmenter = UtteranceSegmenter()

        completed = segmenter.push(silence(0.5) + speech(1.5))
        self.assertEqual(completed, [])
        self.assertTrue(segmenter.is_speaking)

        tail = segmenter.flush()

        self.assertIsNotNone(tail)
        self.assertGreaterEqual(tail.seconds, 1.4)
        self.assertFalse(segmenter.is_speaking)

    def test_chunk_boundaries_do_not_change_segmentation(self):
        stream = silence(1.0) + speech(2.0) + silence(1.5)

        whole = UtteranceSegmenter()
        whole_result = whole.push(stream)

        # 1024-sample chunks are what the WASAPI capture callback delivers.
        chunked = UtteranceSegmenter()
        chunked_result = []
        step = FRAME_SAMPLES * 2 * 2 + 7  # deliberately not frame-aligned
        for offset in range(0, len(stream), step):
            chunked_result.extend(chunked.push(stream[offset : offset + step]))

        self.assertEqual(len(whole_result), len(chunked_result))
        self.assertEqual(whole_result[0].pcm, chunked_result[0].pcm)

    def test_speech_seconds_tracks_only_emitted_audio(self):
        segmenter = UtteranceSegmenter()

        completed = segmenter.push(silence(2.0) + speech(2.0) + silence(2.0))

        self.assertAlmostEqual(
            segmenter.speech_seconds,
            sum(item.seconds for item in completed),
            places=6,
        )
        # Six seconds went in; far less than that is billable.
        self.assertLess(segmenter.speech_seconds, segmenter.total_seconds * 0.6)


if __name__ == "__main__":
    unittest.main()
