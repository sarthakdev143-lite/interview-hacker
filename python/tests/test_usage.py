# Copyright (c) 2026 Sarthak Parulekar
# SPDX-License-Identifier: MIT

from __future__ import annotations

import sys
import unittest
from pathlib import Path

PYTHON_DIR = Path(__file__).resolve().parents[1]
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

from usage import UsageTracker, estimate_tokens  # noqa: E402


class UsageTrackerTests(unittest.TestCase):
    def test_an_hour_of_groq_whisper_costs_four_cents(self):
        tracker = UsageTracker(provider="groq", stt_model="whisper-large-v3-turbo")

        tracker.record_audio(3600.0)

        snapshot = tracker.snapshot()
        self.assertAlmostEqual(snapshot["stt_usd"], 0.04, places=4)
        self.assertEqual(snapshot["stt_requests"], 1)

    def test_deepgram_bills_connection_time_not_speech(self):
        tracker = UsageTracker(provider="deepgram")

        tracker.set_stream_seconds(3600.0)

        snapshot = tracker.snapshot()
        # 60 minutes at $0.0059/min, whether or not anyone spoke.
        self.assertAlmostEqual(snapshot["stt_usd"], 0.354, places=4)

    def test_groq_is_an_order_of_magnitude_cheaper_for_a_real_interview(self):
        """A 60 minute interview that contained 25 minutes of speech."""
        groq = UsageTracker(provider="groq")
        groq.record_audio(25 * 60)

        deepgram = UsageTracker(provider="deepgram")
        deepgram.set_stream_seconds(60 * 60)

        self.assertLess(
            groq.snapshot()["stt_usd"] * 10,
            deepgram.snapshot()["stt_usd"],
        )

    def test_stream_seconds_replaces_rather_than_accumulates(self):
        tracker = UsageTracker(provider="deepgram")

        tracker.set_stream_seconds(60.0)
        tracker.set_stream_seconds(120.0)

        self.assertEqual(tracker.snapshot()["audio_seconds"], 120.0)

    def test_llm_tokens_are_priced_per_model(self):
        tracker = UsageTracker()

        tracker.record_llm(
            "llama-3.3-70b-versatile",
            input_tokens=1_000_000,
            output_tokens=0,
        )

        self.assertAlmostEqual(tracker.snapshot()["llm_usd"], 0.59, places=4)

    def test_unknown_model_falls_back_instead_of_raising(self):
        tracker = UsageTracker()

        tracker.record_llm("some-future-model", input_tokens=1000, output_tokens=1000)

        self.assertGreater(tracker.snapshot()["llm_usd"], 0.0)

    def test_estimated_total_combines_both_meters(self):
        tracker = UsageTracker(provider="groq")

        tracker.record_audio(1800.0)
        tracker.record_llm("llama-3.3-70b-versatile", input_tokens=5000, output_tokens=800)

        snapshot = tracker.snapshot()
        self.assertAlmostEqual(
            snapshot["estimated_usd"],
            snapshot["stt_usd"] + snapshot["llm_usd"],
            places=6,
        )
        self.assertEqual(snapshot["llm_requests"], 1)

    def test_a_typical_free_tier_interview_stays_under_a_cent(self):
        tracker = UsageTracker(provider="groq")

        # 20 minutes of speech and 15 answered questions.
        tracker.record_audio(20 * 60)
        for _ in range(15):
            tracker.record_llm(
                "llama-3.3-70b-versatile",
                input_tokens=1200,
                output_tokens=220,
            )

        self.assertLess(tracker.snapshot()["estimated_usd"], 0.03)

    def test_negative_values_are_ignored(self):
        tracker = UsageTracker()

        tracker.record_audio(-5.0)
        tracker.set_stream_seconds(-5.0)

        self.assertEqual(tracker.snapshot()["audio_seconds"], 0.0)
        self.assertEqual(tracker.snapshot()["stt_requests"], 0)

    def test_token_estimate_is_non_zero_for_real_text(self):
        self.assertEqual(estimate_tokens(""), 0)
        self.assertGreater(estimate_tokens("a reasonably long sentence"), 0)


if __name__ == "__main__":
    unittest.main()
