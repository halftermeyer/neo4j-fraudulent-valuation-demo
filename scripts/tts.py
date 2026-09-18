#!/usr/bin/env python3
"""Narration TTS for the demo video — provider-pluggable, cached by text hash.

Default provider: Gemini TTS (GEMINI_API_KEY from .env / inputs/.env), one
consistent English voice. Swap providers with TTS_PROVIDER=elevenlabs (stub —
wire your key and implementation in ElevenLabsTTS).

CLI:  uv run python scripts/tts.py "text to speak"   -> prints the wav path
"""

import hashlib
import os
import sys
import time
import wave
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
load_dotenv(ROOT / "inputs" / ".env")

DEFAULT_OUT = ROOT / "dist" / "audio"


class GeminiTTS:
    """gemini-2.5-flash-preview-tts -> 16-bit 24 kHz mono PCM, wrapped as WAV."""

    model = "gemini-2.5-flash-preview-tts"
    voice = "Kore"  # one consistent English voice for the whole video

    def __init__(self) -> None:
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise SystemExit("GEMINI_API_KEY not set (inputs/.env) — or use --no-audio")
        from google import genai  # lazy: --no-audio must not require it

        self._genai = genai
        self.client = genai.Client(api_key=api_key)

    def synth_pcm(self, text: str) -> bytes:
        types = self._genai.types
        resp = self.client.models.generate_content(
            model=self.model,
            contents=text,
            config=types.GenerateContentConfig(
                response_modalities=["AUDIO"],
                speech_config=types.SpeechConfig(
                    voice_config=types.VoiceConfig(
                        prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=self.voice)
                    )
                ),
            ),
        )
        part = resp.candidates[0].content.parts[0]
        data = part.inline_data.data
        if not data:
            raise RuntimeError("empty audio from Gemini TTS")
        return data


class ElevenLabsTTS:
    """Stub — select with TTS_PROVIDER=elevenlabs and implement synth_pcm."""

    voice = os.getenv("ELEVENLABS_VOICE", "default")

    def __init__(self) -> None:
        if not os.getenv("ELEVENLABS_API_KEY"):
            raise SystemExit(
                "TTS_PROVIDER=elevenlabs selected but ELEVENLABS_API_KEY is not set — "
                "set the key and implement ElevenLabsTTS.synth_pcm (scripts/tts.py)."
            )
        raise SystemExit("ElevenLabsTTS.synth_pcm not implemented yet (scripts/tts.py).")

    def synth_pcm(self, text: str) -> bytes:  # pragma: no cover
        raise NotImplementedError


def get_provider():
    return ElevenLabsTTS() if os.getenv("TTS_PROVIDER") == "elevenlabs" else GeminiTTS()


def synthesize(text: str, out_dir: Path = DEFAULT_OUT, provider=None) -> Path:
    """One WAV per narration text, cached by sha256(voice|text)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    voice = getattr(provider, "voice", GeminiTTS.voice) if provider else GeminiTTS.voice
    key = hashlib.sha256(f"{voice}|{text}".encode()).hexdigest()[:16]
    out = out_dir / f"{key}.wav"
    if out.exists():
        return out
    if provider is None:
        provider = get_provider()
    last: Exception | None = None
    for attempt in range(3):
        try:
            pcm = provider.synth_pcm(text)
            with wave.open(str(out), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(24_000)
                w.writeframes(pcm)
            return out
        except SystemExit:
            raise
        except Exception as exc:  # transient API errors
            last = exc
            print(f"  tts retry {attempt + 1}/3: {exc}", file=sys.stderr)
            time.sleep(5)
    raise RuntimeError(f"TTS failed after 3 attempts: {last}")


def duration_seconds(wav_path: Path) -> float:
    with wave.open(str(wav_path), "rb") as w:
        return w.getnframes() / w.getframerate()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit('usage: tts.py "text to speak"')
    path = synthesize(" ".join(sys.argv[1:]))
    print(f"{path}  ({duration_seconds(path):.1f}s)")
