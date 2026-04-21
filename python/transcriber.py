from __future__ import annotations

import io
import wave
from typing import Optional

from groq import Groq


class Transcriber:
    def __init__(
        self,
        api_key: str,
        language: str = "en",
        model: str = "whisper-large-v3-turbo",
    ):
        self.client = Groq(api_key=api_key)
        self.model = model
        self.language = language
        self.buffer: list[bytes] = []
        self.buffer_duration = 1.8
        self.min_flush_duration = 0.5
        self.sample_rate = 16000
        self.bytes_per_second = self.sample_rate * 2
        self.buffered_bytes = 0

    def feed(self, audio_chunk: bytes) -> Optional[str]:
        if not audio_chunk:
            return None

        self.buffer.append(audio_chunk)
        self.buffered_bytes += len(audio_chunk)

        if self.buffered_bytes < self.bytes_per_second * self.buffer_duration:
            return None

        return self.transcribe_buffer()

    def flush(self) -> Optional[str]:
        if self.buffered_bytes < self.bytes_per_second * self.min_flush_duration:
            self.buffer.clear()
            self.buffered_bytes = 0
            return None

        return self.transcribe_buffer()

    def has_buffered_audio(self) -> bool:
        return self.buffered_bytes > 0

    def transcribe_buffer(self) -> Optional[str]:
        audio_bytes = b"".join(self.buffer)
        self.buffer.clear()
        self.buffered_bytes = 0

        wav_buffer = io.BytesIO()
        with wave.open(wav_buffer, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(self.sample_rate)
            wav_file.writeframes(audio_bytes)

        response = self.client.audio.transcriptions.create(
            file=("audio.wav", wav_buffer.getvalue()),
            model=self.model,
            language=self.language,
            response_format="text",
            temperature=0.0,
        )

        if isinstance(response, str):
            return response.strip()

        text = getattr(response, "text", "")
        return str(text).strip() or None
