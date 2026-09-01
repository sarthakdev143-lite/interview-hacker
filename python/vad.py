# Copyright (c) 2026 Sarthak Parulekar
# Licensed under MIT + Commons Clause — commercial use prohibited.

"""Energy-based voice activity detection and utterance segmentation.

The point of this module is cost: cloud speech-to-text is billed per second of
audio, so an interview that is 60 minutes long but only 25 minutes of speech
should cost 25 minutes, not 60. Everything below exists to make sure silence
never reaches a paid API.

The detector is deliberately dependency-free (numpy only, which the audio path
already needs) and runs comfortably in real time on a single thread.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Callable

import numpy as np

from wingman_logging import get_logger

log = get_logger("vad")

SAMPLE_RATE = 16000
FRAME_SAMPLES = 512
FRAME_BYTES = FRAME_SAMPLES * 2
FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE  # 32 ms

# Consecutive speech frames required before an utterance opens. Short enough to
# catch a quick "why?", long enough to ignore a keyboard click.
SPEECH_ONSET_FRAMES = 3

# Silence required to close an utterance (~700 ms). Interviewers pause mid
# sentence, so closing too early splits one question into two API calls.
SILENCE_HANGOVER_FRAMES = 22

# Audio kept from before the onset so word beginnings are not clipped.
PREROLL_FRAMES = 8

# Silence kept at the end so word endings are not clipped.
TRAILING_KEEP_FRAMES = 5

# Voiced frames required before an utterance is worth an API call (~256 ms).
# This counts *speech* frames, not clip length: the pre-roll and the retained
# tail are padding, and letting them satisfy the minimum would send every
# keyboard click and chair creak to a paid endpoint.
MIN_SPEECH_FRAMES = 8

# Hard cap (~25 s) so a monologue still gets transcribed in usable pieces.
MAX_UTTERANCE_FRAMES = 780

# Absolute floor in int16 RMS (~-49 dBFS). Guards against a silent room
# adapting the noise estimate down to zero and then treating hiss as speech.
ABSOLUTE_RMS_FLOOR = 110.0

# How fast the noise estimate follows the room while nobody is speaking.
NOISE_ADAPT_RATE = 0.05
INITIAL_NOISE_RMS = 60.0

# Speech must exceed the noise estimate by this factor.
SPEECH_RMS_MULTIPLIER = 2.5


@dataclass(frozen=True)
class Utterance:
    """A contiguous span of speech, ready to send to a transcription API."""

    pcm: bytes
    seconds: float


class UtteranceSegmenter:
    """Splits a 16 kHz mono int16 PCM stream into speech utterances.

    Feed arbitrary-sized chunks to :meth:`push`; it returns whichever
    utterances completed during that chunk (usually none).
    """

    def __init__(
        self,
        *,
        sample_rate: int = SAMPLE_RATE,
        min_speech_frames: int = MIN_SPEECH_FRAMES,
        max_utterance_frames: int = MAX_UTTERANCE_FRAMES,
        silence_hangover_frames: int = SILENCE_HANGOVER_FRAMES,
        on_speech_start: Callable[[], None] | None = None,
        on_speech_end: Callable[[], None] | None = None,
    ):
        self.sample_rate = sample_rate
        self.min_speech_frames = min_speech_frames
        self.max_utterance_frames = max_utterance_frames
        self.silence_hangover_frames = silence_hangover_frames
        # Reported at the frame where the transition happens, so a caller that
        # pushes one large buffer still sees an utterance open and close.
        self.on_speech_start = on_speech_start
        self.on_speech_end = on_speech_end

        self.noise_rms = INITIAL_NOISE_RMS
        self.total_frames = 0
        self.speech_frames = 0

        self._residue = b""
        self._frames: list[bytes] = []
        self._preroll: deque[bytes] = deque(maxlen=PREROLL_FRAMES)
        self._active = False
        self._onset_run = 0
        self._silence_run = 0
        self._voiced_frames = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def push(self, pcm: bytes) -> list[Utterance]:
        if not pcm:
            return []

        self._residue += pcm
        completed: list[Utterance] = []

        while len(self._residue) >= FRAME_BYTES:
            frame = self._residue[:FRAME_BYTES]
            self._residue = self._residue[FRAME_BYTES:]
            utterance = self._push_frame(frame)
            if utterance is not None:
                completed.append(utterance)

        return completed

    def flush(self) -> Utterance | None:
        """Closes an in-progress utterance, e.g. when the stream ends."""
        if not self._active:
            return None
        return self._close()

    @property
    def is_speaking(self) -> bool:
        return self._active

    @property
    def total_seconds(self) -> float:
        return self.total_frames * FRAME_SECONDS

    @property
    def speech_seconds(self) -> float:
        return self.speech_frames * FRAME_SECONDS

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _push_frame(self, frame: bytes) -> Utterance | None:
        self.total_frames += 1
        rms = self._frame_rms(frame)
        threshold = max(self.noise_rms * SPEECH_RMS_MULTIPLIER, ABSOLUTE_RMS_FLOOR)
        is_speech = rms > threshold

        if not self._active:
            self._preroll.append(frame)

            if not is_speech:
                self._onset_run = 0
                # Only adapt while idle, so a long answer cannot drag the noise
                # estimate up and deafen the detector.
                self.noise_rms = (
                    (1.0 - NOISE_ADAPT_RATE) * self.noise_rms + NOISE_ADAPT_RATE * rms
                )
                return None

            self._onset_run += 1
            if self._onset_run < SPEECH_ONSET_FRAMES:
                return None

            self._active = True
            self._silence_run = 0
            # The frames that triggered the onset are speech and already sit in
            # the pre-roll buffer, so they count toward the voiced total.
            self._voiced_frames = SPEECH_ONSET_FRAMES
            self._frames = list(self._preroll)
            self._preroll.clear()
            self._notify(self.on_speech_start)
            return None

        self._frames.append(frame)
        if is_speech:
            self._silence_run = 0
            self._voiced_frames += 1
        else:
            self._silence_run += 1

        if (
            self._silence_run >= self.silence_hangover_frames
            or len(self._frames) >= self.max_utterance_frames
        ):
            return self._close()

        return None

    def _close(self) -> Utterance | None:
        frames = self._frames
        trailing_silence = self._silence_run
        voiced_frames = self._voiced_frames

        self._frames = []
        self._active = False
        self._onset_run = 0
        self._silence_run = 0
        self._voiced_frames = 0
        self._preroll.clear()
        self._notify(self.on_speech_end)

        # Drop the hangover silence but keep a short tail so the final
        # consonant survives.
        trim = max(0, trailing_silence - TRAILING_KEEP_FRAMES)
        if trim:
            frames = frames[: len(frames) - trim]

        if voiced_frames < self.min_speech_frames or not frames:
            return None

        self.speech_frames += len(frames)
        return Utterance(
            pcm=b"".join(frames),
            seconds=len(frames) * FRAME_SECONDS,
        )

    @staticmethod
    def _notify(callback: Callable[[], None] | None) -> None:
        if callback is None:
            return
        try:
            callback()
        except Exception as error:  # pragma: no cover - defensive
            log.error("VAD callback failed: %s", error, exc_info=True)

    @staticmethod
    def _frame_rms(frame: bytes) -> float:
        samples = np.frombuffer(frame, dtype=np.int16).astype(np.float32)
        if samples.size == 0:
            return 0.0
        return float(np.sqrt(np.mean(np.square(samples))))
