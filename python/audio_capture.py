from __future__ import annotations

import sys
import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional

import numpy as np

try:
    import sounddevice as sd
except Exception:  # pragma: no cover - optional dependency on some platforms
    sd = None


@dataclass
class AudioProbe:
    ready: bool
    message: str
    suggested_device: Optional[str] = None


def probe_audio_environment() -> AudioProbe:
    if sys.platform == "win32":
        try:
            import pyaudiowpatch as pyaudio  # type: ignore
        except Exception:
            return AudioProbe(
                ready=False,
                message="PyAudioWPatch is not installed, so WASAPI loopback capture is unavailable.",
            )

        with pyaudio.PyAudio() as audio:
            try:
                loopback = _find_windows_loopback_device(audio, pyaudio)
            except RuntimeError as error:
                return AudioProbe(ready=False, message=str(error))

        return AudioProbe(
            ready=True,
            message="WASAPI loopback device is ready.",
            suggested_device=str(loopback["name"]),
        )

    if sd is None:
        return AudioProbe(
            ready=False,
            message="The sounddevice package is unavailable, so loopback capture cannot start.",
        )

    device = _find_sounddevice_loopback_device()
    if device is None:
        if sys.platform == "darwin":
            return AudioProbe(
                ready=False,
                message="No BlackHole-style loopback device detected. Install BlackHole and configure a Multi-Output Device in Audio MIDI Setup.",
            )

        return AudioProbe(
            ready=False,
            message="No monitor or loopback input device was found. On Linux, enable a PulseAudio/PipeWire monitor source first.",
        )

    return AudioProbe(
        ready=True,
        message="Loopback device is ready.",
        suggested_device=device["name"],
    )


def _find_windows_loopback_device(audio, pyaudio_module):
    try:
        wasapi_info = audio.get_host_api_info_by_type(pyaudio_module.paWASAPI)
    except OSError as error:
        raise RuntimeError("WASAPI is not available on this system.") from error

    default_output = audio.get_device_info_by_index(wasapi_info["defaultOutputDevice"])
    if default_output.get("isLoopbackDevice"):
        return default_output

    for loopback in audio.get_loopback_device_info_generator():
        if default_output["name"] in loopback["name"]:
            return loopback

    raise RuntimeError(
        "No default WASAPI loopback device was found. Run `python -m pyaudiowpatch` to inspect available devices."
    )


def _find_sounddevice_loopback_device():
    devices = sd.query_devices() if sd is not None else []
    preferred_names = ["blackhole", "loopback", "monitor"]

    for preferred in preferred_names:
        for index, device in enumerate(devices):
            name = str(device["name"]).lower()
            if preferred in name and device["max_input_channels"] > 0:
                return {"index": index, **device}

    return None


class AudioCapture:
    def __init__(self, callback: Callable[[bytes], None]):
        self.callback = callback
        self.stream = None
        self.audio_interface = None
        self.running = False
        self.worker: Optional[threading.Thread] = None
        self.stop_event = threading.Event()
        self.sample_rate = 16000
        self.channels = 1
        self.chunk_size = 1024
        self.source_rate = 16000
        self.source_channels = 1

    def start(self):
        if self.running:
            return

        self.stop_event.clear()
        self.running = True

        if sys.platform == "win32":
            self._start_windows()
            return

        self._start_sounddevice()

    def stop(self):
        self.running = False
        self.stop_event.set()

        if self.stream is not None:
            try:
                if hasattr(self.stream, "stop_stream"):
                    self.stream.stop_stream()
                else:
                    self.stream.stop()
            except Exception:
                pass
            try:
                self.stream.close()
            except Exception:
                pass
            self.stream = None

        if self.audio_interface is not None:
            try:
                self.audio_interface.terminate()
            except Exception:
                pass
            self.audio_interface = None

        if self.worker is not None and self.worker.is_alive():
            self.worker.join(timeout=1.5)
        self.worker = None

    def _start_windows(self):
        try:
            import pyaudiowpatch as pyaudio  # type: ignore
        except Exception as error:
            self.running = False
            raise RuntimeError(
                "PyAudioWPatch is required on Windows for speaker loopback capture."
            ) from error

        audio = pyaudio.PyAudio()
        device = _find_windows_loopback_device(audio, pyaudio)

        self.source_rate = int(device["defaultSampleRate"])
        self.source_channels = max(1, min(int(device["maxInputChannels"] or 1), 2))

        def callback(in_data, frame_count, time_info, status):
            if not self.running:
                return (None, pyaudio.paComplete)

            normalized = self._normalize_chunk(in_data)
            if normalized:
                self.callback(normalized)
            return (in_data, pyaudio.paContinue)

        self.audio_interface = audio
        self.stream = audio.open(
            format=pyaudio.paInt16,
            channels=self.source_channels,
            rate=self.source_rate,
            frames_per_buffer=self.chunk_size,
            input=True,
            input_device_index=device["index"],
            stream_callback=callback,
        )
        self.stream.start_stream()
        self.worker = threading.Thread(target=self._spin_stream, daemon=True)
        self.worker.start()

    def _start_sounddevice(self):
        if sd is None:
            self.running = False
            raise RuntimeError("sounddevice is not installed.")

        device = _find_sounddevice_loopback_device()
        if device is None:
            self.running = False
            if sys.platform == "darwin":
                raise RuntimeError(
                    "No BlackHole device was found. Install BlackHole and configure a loopback input before starting a session."
                )
            raise RuntimeError(
                "No monitor loopback input device was found. Configure a PulseAudio/PipeWire monitor source first."
            )

        self.source_rate = int(device["default_samplerate"])
        self.source_channels = max(1, min(int(device["max_input_channels"] or 1), 2))

        def callback(indata, frames, time_info, status):
            if not self.running:
                return

            normalized = self._normalize_chunk(bytes(indata))
            if normalized:
                self.callback(normalized)

        self.stream = sd.RawInputStream(
            samplerate=self.source_rate,
            blocksize=self.chunk_size,
            device=device["index"],
            channels=self.source_channels,
            dtype="int16",
            callback=callback,
        )
        self.stream.start()
        self.worker = threading.Thread(target=self._spin_stream, daemon=True)
        self.worker.start()

    def _spin_stream(self):
        while self.running and not self.stop_event.is_set():
            time.sleep(0.1)

    def _normalize_chunk(self, audio_chunk: bytes) -> bytes:
        if not audio_chunk:
            return b""

        samples = np.frombuffer(audio_chunk, dtype=np.int16)
        if samples.size == 0:
            return b""

        if self.source_channels > 1:
            trimmed = samples[: samples.size - (samples.size % self.source_channels)]
            samples = trimmed.reshape(-1, self.source_channels).mean(axis=1).astype(np.int16)

        if self.source_rate != self.sample_rate:
            target_length = max(
                1, int(len(samples) * (self.sample_rate / float(self.source_rate)))
            )
            source_positions = np.linspace(0, 1, num=len(samples), endpoint=False)
            target_positions = np.linspace(0, 1, num=target_length, endpoint=False)
            samples = np.interp(
                target_positions,
                source_positions,
                samples.astype(np.float32),
            ).clip(-32768, 32767).astype(np.int16)

        return samples.astype(np.int16).tobytes()
