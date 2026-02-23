"""
Voice Interface — FastAPI backend
Pure relay: voice → STT → Agent Zero → TTS → voice

WebSocket protocol  (ws://host:8000/ws)
───────────────────
Client → Server
  { type: "auth",         token: str }
  { type: "audio_chunk",  data: str }          base64 audio bytes
  { type: "audio_end" }                         VAD silence detected → trigger STT
  { type: "text_message", text: str }           text input (fallback / debug)
  { type: "select_chat",  chat_id: str }
  { type: "new_chat",     name: str }
  { type: "list_chats" }

Server → Client
  { type: "auth_ok" }
  { type: "auth_error",   message: str }
  { type: "transcript",   text: str }           what Whisper heard
  { type: "agent_update", text: str,            streaming log line from Agent Zero
                          partial: true }
  { type: "agent_done",   text: str }           final agent response
  { type: "audio_chunk",  data: str }           base64 MP3 chunk
  { type: "audio_end" }                         TTS stream finished
  { type: "chat_list",    chats: [...] }
  { type: "chat_created", chat: {...} }
  { type: "error",        message: str }
"""
import asyncio
import base64
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .adapters.agent_zero import AgentZeroAdapter
from .voice.stt import transcribe_audio
from .voice.tts import stream_tts
from .memory.session import store as session_store
from .memory.compressor import maybe_compress, build_context_for_agent

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# ── Lifespan ──────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Voice relay starting — Agent Zero at %s", settings.agent_zero_url)
    # Quick health check at startup (non-blocking)
    asyncio.create_task(_startup_health_check())
    yield
    log.info("Voice relay shutting down")


async def _startup_health_check():
    adapter = AgentZeroAdapter()
    ok = await adapter.health_check()
    status = "✅ reachable" if ok else "⚠️  unreachable (check AGENT_ZERO_URL / API key)"
    log.info("Agent Zero: %s", status)


# ── App ───────────────────────────────────────────────────────────────

app = FastAPI(
    title="Voice Relay",
    description="Relay voice ↔ Agent Zero",
    version="3.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── REST ──────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    adapter = AgentZeroAdapter()
    agent_ok = await adapter.health_check()
    return {
        "status": "healthy",
        "agent_zero": "connected" if agent_ok else "unreachable",
        "timestamp": datetime.utcnow().isoformat(),
    }


@app.get("/")
async def root():
    return {"message": "Voice Relay v3.0", "ws": "/ws", "docs": "/docs"}


# ── WebSocket ─────────────────────────────────────────────────────────

class RelaySession:
    """State for one connected mobile client."""

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.authenticated = False
        self.active_chat_id: Optional[str] = None
        self._audio_buffer: list[bytes] = []

    async def send(self, data: dict):
        try:
            await self.ws.send_json(data)
        except Exception as exc:
            log.warning("Failed to send to client: %s", exc)

    # ── audio buffer ──────────────────────────────────────────────────

    def buffer_audio(self, chunk_b64: str):
        self._audio_buffer.append(base64.b64decode(chunk_b64))

    def pop_audio(self) -> bytes:
        data = b"".join(self._audio_buffer)
        self._audio_buffer.clear()
        return data

    def clear_audio(self):
        self._audio_buffer.clear()


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    session = RelaySession(ws)
    log.info("Client connected")

    try:
        while True:
            msg = await ws.receive_json()
            await _handle_message(session, msg)

    except WebSocketDisconnect:
        log.info("Client disconnected")
    except Exception as exc:
        log.error("WebSocket error: %s", exc, exc_info=True)


# ── Message router ────────────────────────────────────────────────────

async def _handle_message(s: RelaySession, msg: dict):
    t = msg.get("type")

    # Auth must come first
    if t == "auth":
        await _handle_auth(s, msg)
        return

    if not s.authenticated:
        await s.send({"type": "auth_error", "message": "Not authenticated"})
        return

    match t:
        case "audio_chunk":
            s.buffer_audio(msg.get("data", ""))

        case "audio_end":
            await _handle_audio_end(s)

        case "text_message":
            text = (msg.get("text") or "").strip()
            if text:
                await _relay_to_agent(s, text)

        case "select_chat":
            await _handle_select_chat(s, msg)

        case "new_chat":
            await _handle_new_chat(s, msg)

        case "list_chats":
            await _handle_list_chats(s)

        case _:
            log.warning("Unknown message type: %s", t)


# ── Handlers ──────────────────────────────────────────────────────────

async def _handle_auth(s: RelaySession, msg: dict):
    token = msg.get("token", "")
    if token == settings.app_secret:
        s.authenticated = True
        await s.send({"type": "auth_ok"})
        log.info("Client authenticated")
    else:
        await s.send({"type": "auth_error", "message": "Invalid token"})
        log.warning("Auth failed — wrong token")


async def _handle_audio_end(s: RelaySession):
    audio = s.pop_audio()
    if not audio:
        return

    # 1. Transcribe
    await s.send({"type": "transcript", "text": "…"})   # show spinner
    text = await transcribe_audio(audio, filename="audio.m4a")
    if not text:
        await s.send({"type": "error", "message": "Could not understand audio"})
        return

    await s.send({"type": "transcript", "text": text})
    await _relay_to_agent(s, text)


async def _relay_to_agent(s: RelaySession, text: str):
    """
    Core relay loop:
      1. save user message
      2. start streaming Agent Zero updates to the client
      3. send message to Agent Zero (blocks until done)
      4. save assistant response
      5. stream TTS audio back
      6. kick off background memory compression
    """
    # Ensure we have a chat
    if not s.active_chat_id:
        chat = await session_store.create_chat("New Chat")
        s.active_chat_id = chat.id
        await s.send({"type": "chat_created", "chat": _chat_to_dict(chat)})

    chat_id = s.active_chat_id

    # Persist user message
    await session_store.add_message(chat_id, "user", text)

    # Get existing Agent Zero context for this chat
    chat = await session_store.get_chat(chat_id)
    az_context_id = chat.agent_context_id if chat else None

    # Build context preamble for first message or resumed chat
    preamble = await build_context_for_agent(chat_id)
    full_text = f"{preamble}\n\nUser: {text}" if preamble and not az_context_id else text

    adapter = AgentZeroAdapter()

    # Run send_message and stream_updates concurrently
    # stream_updates subscribes to Socket.IO before send_message posts
    response_holder: list[str] = []
    ctx_holder: list[str] = []

    async def _send():
        response, ctx = await adapter.send_message(full_text, az_context_id)
        response_holder.append(response)
        ctx_holder.append(ctx)

    async def _stream():
        # We start streaming before send so we don't miss early events.
        # If az_context_id is None, stream_updates won't have a context yet —
        # that's OK, Agent Zero will create one and we catch updates via
        # the global Socket.IO broadcast.
        target_ctx = az_context_id or ""
        async for update in adapter.stream_updates(target_ctx):
            await s.send({"type": "agent_update", "text": update, "partial": True})

    # Fire both; streaming exits naturally when agent goes idle
    await asyncio.gather(_send(), _stream())

    response_text = response_holder[0] if response_holder else ""
    returned_ctx = ctx_holder[0] if ctx_holder else az_context_id

    # Save the context_id if it's new
    if returned_ctx and returned_ctx != az_context_id:
        await session_store.set_agent_context(chat_id, returned_ctx)

    if not response_text:
        await s.send({"type": "error", "message": "No response from agent"})
        return

    # Persist assistant response
    await session_store.add_message(chat_id, "assistant", response_text)

    # Send final text to UI
    await s.send({"type": "agent_done", "text": response_text})

    # Stream TTS audio
    async for chunk in stream_tts(response_text):
        chunk_b64 = base64.b64encode(chunk).decode()
        await s.send({"type": "audio_chunk", "data": chunk_b64})
    await s.send({"type": "audio_end"})

    # Kick off background memory compression (fire and forget)
    asyncio.create_task(maybe_compress(chat_id))


async def _handle_select_chat(s: RelaySession, msg: dict):
    chat_id = msg.get("chat_id")
    if not chat_id:
        return
    chat = await session_store.get_chat(chat_id)
    if not chat:
        await s.send({"type": "error", "message": f"Chat {chat_id} not found"})
        return
    s.active_chat_id = chat_id
    # Send back the chat's messages so the UI can restore history
    messages = await session_store.get_messages(chat_id)
    await s.send({
        "type": "chat_selected",
        "chat": _chat_to_dict(chat),
        "messages": [_message_to_dict(m) for m in messages],
    })


async def _handle_new_chat(s: RelaySession, msg: dict):
    name = (msg.get("name") or "New Chat").strip()
    chat = await session_store.create_chat(name)
    s.active_chat_id = chat.id
    await s.send({"type": "chat_created", "chat": _chat_to_dict(chat)})


async def _handle_list_chats(s: RelaySession):
    chats = await session_store.list_chats()
    await s.send({"type": "chat_list", "chats": [_chat_to_dict(c) for c in chats]})


# ── Serialisers ───────────────────────────────────────────────────────

def _chat_to_dict(chat) -> dict:
    return {
        "id": chat.id,
        "name": chat.name,
        "agent_context_id": chat.agent_context_id,
        "has_summary": bool(chat.summary),
        "created_at": chat.created_at.isoformat(),
        "updated_at": chat.updated_at.isoformat(),
    }


def _message_to_dict(msg) -> dict:
    return {
        "id": msg.id,
        "role": msg.role,
        "text": msg.text,
        "created_at": msg.created_at.isoformat(),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)
