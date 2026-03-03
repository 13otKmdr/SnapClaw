"""
Background memory compressor.
Runs after every COMPRESS_EVERY messages in a chat.

Strategy (mirrors Agent Zero's approach):
  keep  messages[0]                    ← first message sets the topic
  keep  compressed summary of middle   ← gpt-4o-mini condenses it
  keep  last KEEP_TAIL exchanges       ← verbatim recent context

The compressed summary is stored on the Chat row and prepended as a
'system' message when building context for Agent Zero.
"""
import logging
from openai import AsyncOpenAI

from .session import store as session_store
from ..config import settings

log = logging.getLogger(__name__)

COMPRESS_EVERY = 10   # trigger after this many total messages
KEEP_TAIL = 6         # keep this many recent messages verbatim (3 exchanges)

_SYSTEM_PROMPT = (
    "You are a memory compressor. Given a conversation history, produce a "
    "concise summary that preserves all important facts, decisions, goals, "
    "names, numbers, and context. Remove pleasantries, filler, and repetition. "
    "Write in third-person past tense. Be as brief as possible while keeping "
    "everything a future reader would need to continue the conversation."
)

_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=settings.openai_api_key)
    return _client


async def maybe_compress(chat_id: str) -> None:
    """
    Check if this chat needs compression and run it if so.
    Designed to be fire-and-forget (call with asyncio.create_task).
    """
    try:
        count = await session_store.message_count(chat_id)
        if count < COMPRESS_EVERY:
            return

        messages = await session_store.get_messages(chat_id)
        if len(messages) < COMPRESS_EVERY:
            return

        # Split: keep first, compress middle, keep tail
        first = messages[0]  # noqa: F841
        tail = messages[-KEEP_TAIL:]  # noqa: F841
        middle = messages[1: len(messages) - KEEP_TAIL]

        if not middle:
            return   # nothing to compress yet

        # Build the conversation text for the compressor
        convo_text = "\n".join(
            f"{m.role.upper()}: {m.text}" for m in middle
        )

        client = _get_client()
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": convo_text},
            ],
            max_tokens=512,
            temperature=0.2,
        )

        summary = response.choices[0].message.content or ""
        summary = summary.strip()

        if summary:
            await session_store.update_summary(chat_id, summary)
            log.info("Compressed chat %s (%d msgs → summary)", chat_id, len(middle))

    except Exception as exc:
        log.error("Memory compression failed for chat %s: %s", chat_id, exc)


async def build_context_for_agent(chat_id: str) -> str:
    """
    Build the context string to send to Agent Zero when resuming a chat.

    Format:
      [CONVERSATION SUMMARY]
      <compressed summary>

      [RECENT MESSAGES]
      USER: ...
      ASSISTANT: ...
      ...
    """
    chat = await session_store.get_chat(chat_id)
    if not chat:
        return ""

    messages = await session_store.get_messages(chat_id)
    if not messages:
        return ""

    parts: list[str] = []

    if chat.summary:
        parts.append(f"[CONVERSATION SUMMARY]\n{chat.summary}")

    # Include recent tail (or all if short conversation)
    recent = messages[-KEEP_TAIL:] if len(messages) > KEEP_TAIL else messages
    recent_text = "\n".join(
        f"{m.role.upper()}: {m.text}" for m in recent
    )
    parts.append(f"[RECENT MESSAGES]\n{recent_text}")

    return "\n\n".join(parts)
