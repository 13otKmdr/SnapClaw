"""
Speech-to-text via OpenAI Whisper API.
Accepts raw audio bytes (any format Whisper supports: m4a, webm, mp4, wav, etc.)
and returns the transcribed text string.
"""
import io
import logging
from openai import AsyncOpenAI

from ..config import settings

log = logging.getLogger(__name__)

_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=settings.openai_api_key)
    return _client


async def transcribe_audio(audio_bytes: bytes, filename: str = "audio.m4a") -> str:
    """
    Transcribe audio bytes using Whisper.

    Args:
        audio_bytes: raw audio data
        filename:    hint for file format (extension matters to Whisper)

    Returns:
        Transcribed text, or empty string on failure.
    """
    if not audio_bytes:
        return ""

    if not settings.openai_api_key:
        log.warning("STT skipped — no OPENAI_API_KEY configured")
        return ""

    client = _get_client()

    # Wrap bytes in a file-like object with a name so the API knows the format
    audio_file = io.BytesIO(audio_bytes)
    audio_file.name = filename

    try:
        result = await client.audio.transcriptions.create(
            model="whisper-1",
            file=audio_file,
            response_format="text",
        )
        # When response_format="text", result is a plain string
        text = result.strip() if isinstance(result, str) else (result.text or "").strip()
        log.debug("STT: %r", text)
        return text
    except Exception as exc:
        log.error("Whisper transcription failed: %s", exc)
        return ""
