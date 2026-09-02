# Copyright (c) 2026 Sarthak Parulekar
# SPDX-License-Identifier: MIT

"""Per-session spend tracking.

WingMan is meant to run for free or close to it, so the app shows what a
session actually costs rather than asking the user to trust that it is cheap.
Transcription seconds are measured exactly; LLM tokens come from the provider
response when it reports them and fall back to a character estimate when it
does not.
"""

from __future__ import annotations

import threading

# Groq speech-to-text, USD per hour of audio.
STT_USD_PER_HOUR = {
    "whisper-large-v3-turbo": 0.04,
    "whisper-large-v3": 0.111,
    "distil-whisper-large-v3-en": 0.02,
}
DEFAULT_STT_USD_PER_HOUR = 0.04

# Deepgram streaming, USD per minute of *connection* time (silence included).
DEEPGRAM_USD_PER_MINUTE = 0.0059

# Groq chat models, USD per million (input, output) tokens.
LLM_USD_PER_MTOK = {
    "openai/gpt-oss-120b": (0.15, 0.75),
    "openai/gpt-oss-20b": (0.075, 0.30),
    "llama-3.3-70b-versatile": (0.59, 0.79),
    "meta-llama/llama-4-scout-17b-16e-instruct": (0.11, 0.34),
    "meta-llama/llama-4-maverick-17b-128e-instruct": (0.20, 0.60),
}
# Unknown models are costed at a deliberately pessimistic rate so the meter
# errs toward over-reporting rather than under-reporting spend.
DEFAULT_LLM_USD_PER_MTOK = (0.59, 0.79)

# Rough token estimate when the provider does not report usage.
CHARS_PER_TOKEN = 4.0


def _stt_cost(provider: str, model: str, seconds: float) -> float:
    if provider == "deepgram":
        return (seconds / 60.0) * DEEPGRAM_USD_PER_MINUTE

    rate = STT_USD_PER_HOUR.get(model, DEFAULT_STT_USD_PER_HOUR)
    return (seconds / 3600.0) * rate


def _llm_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    input_rate, output_rate = LLM_USD_PER_MTOK.get(model, DEFAULT_LLM_USD_PER_MTOK)
    return (input_tokens * input_rate + output_tokens * output_rate) / 1_000_000.0


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, int(len(text) / CHARS_PER_TOKEN))


class UsageTracker:
    """Thread-safe running total for one session."""

    def __init__(self, *, provider: str = "groq", stt_model: str = "whisper-large-v3-turbo"):
        self.provider = provider
        self.stt_model = stt_model
        self._lock = threading.Lock()

        self.audio_seconds = 0.0
        self.stt_requests = 0
        self.stt_cost = 0.0

        self.llm_requests = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.llm_cost = 0.0

    def record_audio(self, seconds: float) -> None:
        if seconds <= 0:
            return
        with self._lock:
            self.audio_seconds += seconds
            self.stt_requests += 1
            self.stt_cost += _stt_cost(self.provider, self.stt_model, seconds)

    def set_stream_seconds(self, seconds: float) -> None:
        """Replaces the audio total for connection-billed providers.

        Deepgram charges for the time the socket is open, not for the speech
        inside it, so the running total is the session's wall clock.
        """
        if seconds < 0:
            return
        with self._lock:
            self.audio_seconds = seconds
            self.stt_cost = _stt_cost(self.provider, self.stt_model, seconds)

    def record_llm(
        self,
        model: str,
        *,
        input_tokens: int = 0,
        output_tokens: int = 0,
    ) -> None:
        with self._lock:
            self.llm_requests += 1
            self.input_tokens += max(0, input_tokens)
            self.output_tokens += max(0, output_tokens)
            self.llm_cost += _llm_cost(model, max(0, input_tokens), max(0, output_tokens))

    def snapshot(self) -> dict:
        with self._lock:
            total = self.stt_cost + self.llm_cost
            return {
                "provider": self.provider,
                "audio_seconds": round(self.audio_seconds, 1),
                "stt_requests": self.stt_requests,
                "stt_usd": round(self.stt_cost, 6),
                "llm_requests": self.llm_requests,
                "input_tokens": self.input_tokens,
                "output_tokens": self.output_tokens,
                "llm_usd": round(self.llm_cost, 6),
                "estimated_usd": round(total, 6),
            }
