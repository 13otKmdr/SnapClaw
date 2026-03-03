"""
Text-to-speech via OpenAI TTS API.
Streams MP3 audio chunks so the mobile client can start playing
before the full response has been synthesised.
"""

import logging
from typing import AsyncGenerator

from openai import AsyncOpenAI

from ..config import settings

log = logging.getLogger(__name__)

_client: AsyncOpenAI | None = None

# Chunk size for streaming — 4 KB is a good balance between
# latency and number of WebSocket frames
_CHUNK_BYTES = 4096


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=settings.openai_api_key)
    return _client


async def stream_tts(
    text: str, voice: str | None = None
) -> AsyncGenerator[bytes, None]:
    """
    Yield MP3 audio chunks for the given text.

    Args:
        text:  text to synthesise
        voice: optional voice override (defaults to settings.tts_voice)

    Yields:
        Raw MP3 bytes in chunks.
    """
    if not text.strip():
        return

    if not settings.openai_api_key:
        log.debug("TTS skipped — no OPENAI_API_KEY configured")
        return

    chosen_voice = voice or settings.tts_voice
    client = _get_client()

    try:
        async with client.audio.speech.with_streaming_response.create(
            model="tts-1",
            voice=chosen_voice,  # type: ignore[arg-type]
            input=text,
            response_format="mp3",
        ) as response:
            async for chunk in response.iter_bytes(chunk_size=_CHUNK_BYTES):
                if chunk:
                    yield chunk
    except Exception as exc:
        log.error("TTS failed: %s", exc)
