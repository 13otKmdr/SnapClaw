"""Voice Interface Backend - FastAPI Server (Agent Zero only)."""
from __future__ import annotations

import os
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from mimetypes import guess_type
from typing import Any, Dict, List, Optional

import httpx
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from auth import (
    Token,
    UserCreate,
    UserLogin,
    authenticate_user,
    create_access_token,
    create_api_key,
    create_user,
    get_api_key_user,
    get_user_by_email,
)
from integrations.agent_zero import get_agent_zero_client
from orchestration import handle_realtime_proxy, shutdown_orchestration
from orchestration.routes import router as orchestration_router

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "z-ai/glm-5")
OPENROUTER_BASE_URL = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
ZAI_API_KEY = os.environ.get("ZAI_API_KEY", "")
ZAI_MODEL = os.environ.get("ZAI_MODEL", "glm-5")
ZAI_ASR_MODEL = os.environ.get("ZAI_ASR_MODEL", "glm-asr-2512")
ZAI_BASE_URL = os.environ.get("ZAI_BASE_URL", "https://api.z.ai/api/paas/v4")
LLM_TIMEOUT_SECONDS = float(os.environ.get("LLM_TIMEOUT_SECONDS", "45"))
SYSTEM_PROMPT = (
    "You are a concise voice assistant. Be practical and direct. "
    "If the user asks to run tasks, acknowledge and keep context crisp."
)

llm_client = httpx.AsyncClient(timeout=LLM_TIMEOUT_SECONDS)
conversation_history: Dict[str, List[Dict[str, str]]] = {}
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Voice Interface Backend starting...")
    yield
    print("Shutting down...")
    az = get_agent_zero_client()
    await az.close()
    await llm_client.aclose()
    await shutdown_orchestration()


app = FastAPI(
    title="Voice Interface API",
    description="Voice-first AI assistant with Agent Zero integration",
    version="2.1.0",
    lifespan=lifespan,
)

app.include_router(orchestration_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}

    async def connect(self, session_id: str, websocket: WebSocket):
        await websocket.accept()
        self.active_connections[session_id] = websocket

    def disconnect(self, session_id: str):
        self.active_connections.pop(session_id, None)

    async def send_json(self, session_id: str, data: dict):
        ws = self.active_connections.get(session_id)
        if ws:
            await ws.send_json(data)


manager = ConnectionManager()


class VoiceRequest(BaseModel):
    text: str
    session_id: str
    context: Optional[Dict[str, Any]] = None


class VoiceResponse(BaseModel):
    text: str
    intent: str
    confidence: float
    action: Optional[Dict[str, Any]] = None
    requires_confirmation: bool = False
    entities: Optional[Dict[str, Any]] = None


class CommandRequest(BaseModel):
    command: str
    target: Optional[str] = None
    params: Optional[Dict[str, Any]] = None




@app.post("/api/auth/register", response_model=Token, tags=["Auth"])
async def register(user_data: UserCreate):
    if get_user_by_email(user_data.email):
        raise HTTPException(400, "Email already registered")

    user = create_user(user_data.email, user_data.username, user_data.password)
    token = create_access_token({"sub": user.id, "email": user.email})

    return Token(
        access_token=token,
        user={"id": user.id, "email": user.email, "username": user.username},
    )


@app.post("/api/auth/login", response_model=Token, tags=["Auth"])
async def login(credentials: UserLogin):
    user = authenticate_user(credentials.email, credentials.password)
    if not user:
        raise HTTPException(401, "Invalid credentials")

    token = create_access_token({"sub": user.id, "email": user.email})

    return Token(
        access_token=token,
        user={"id": user.id, "email": user.email, "username": user.username},
    )


@app.post("/api/auth/api-keys", tags=["Auth"])
async def create_new_api_key(
    name: str,
    current_user: Dict[str, Any] = Depends(get_api_key_user),
):
    if not current_user:
        raise HTTPException(401, "Authentication required")

    key = create_api_key(current_user["user_id"], name)
    return {"api_key": key, "name": name}


@app.get("/api/auth/me", tags=["Auth"])
async def get_me(current_user: Dict[str, Any] = Depends(get_api_key_user)):
    if not current_user:
        raise HTTPException(401, "Not authenticated")
    return current_user


@app.post("/api/voice/process", response_model=VoiceResponse, tags=["Voice"])
async def process_voice(
    request: VoiceRequest,
    user: Optional[Dict[str, Any]] = Depends(get_api_key_user),
):
    text = request.text.lower()

    intent = "CHAT"
    confidence = 0.9
    entities: Dict[str, Any] = {}
    action = None
    requires_confirmation = False

    if any(word in text for word in ["execute", "run", "agent zero", "task", "delegate"]):
        intent = "COMMAND"
        entities["action"] = "agent_execute"
        requires_confirmation = True
        action = {"type": "agent_execute", "status": "pending"}

    if intent == "CHAT":
        response_text = await generate_llm_response(request.session_id, request.text)
    else:
        response_text = generate_response(text, intent, entities)

    return VoiceResponse(
        text=response_text,
        intent=intent,
        confidence=confidence,
        action=action,
        requires_confirmation=requires_confirmation,
        entities=entities,
    )


@app.post("/api/voice/transcribe", tags=["Voice"])
async def transcribe_voice(
    file: UploadFile = File(...),
    user: Optional[Dict[str, Any]] = Depends(get_api_key_user),
):
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(400, "Uploaded audio file is empty")

    filename = file.filename or "audio.m4a"
    try:
        transcript = await transcribe_audio_bytes(audio_bytes, filename)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc))
    if not transcript:
        raise HTTPException(502, "Transcription failed: empty transcript")

    return {"text": transcript}


@app.post("/api/voice/confirm", tags=["Voice"])
async def confirm_action(
    action_type: str,
    params: Dict[str, Any],
    confirmed: bool = True,
    user: Optional[Dict[str, Any]] = Depends(get_api_key_user),
):
    if not confirmed:
        return {"status": "cancelled", "message": "Action cancelled"}

    result = await execute_action(action_type, params)
    return {"status": "completed", "result": result}


@app.post("/api/agent/execute", tags=["Agent Zero"])
async def execute_agent_task(
    request: CommandRequest,
    user: Optional[Dict[str, Any]] = Depends(get_api_key_user),
):
    az = get_agent_zero_client()
    params = request.params or {}
    try:
        result = await az.execute_task(request.command, params.get("context"))
        return result
    except Exception as exc:
        raise HTTPException(500, f"Agent Zero error: {exc}")


@app.get("/api/agent/capabilities", tags=["Agent Zero"])
async def get_agent_capabilities(user: Optional[Dict[str, Any]] = Depends(get_api_key_user)):
    az = get_agent_zero_client()
    return await az.list_capabilities()


@app.get("/api/agent/health", tags=["Agent Zero"])
async def agent_health():
    az = get_agent_zero_client()
    is_healthy = await az.health_check()
    return {"healthy": is_healthy}


@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    await manager.connect(session_id, websocket)
    try:
        while True:
            data = await websocket.receive_json()

            if data.get("type") == "voice_input":
                text = data.get("text", "")
                response = await process_voice_input(text, session_id)
                await manager.send_json(session_id, response)

            elif data.get("type") == "execute":
                action_type = data.get("action")
                params = data.get("params", {})
                result = await execute_action(action_type, params)
                await manager.send_json(
                    session_id,
                    {
                        "type": "action_result",
                        "action": action_type,
                        "result": result,
                    },
                )
    except WebSocketDisconnect:
        manager.disconnect(session_id)


@app.websocket("/ws/realtime/{conversation_id}")
async def realtime_proxy_endpoint(websocket: WebSocket, conversation_id: str):
    await handle_realtime_proxy(websocket, conversation_id)


async def process_voice_input(text: str, session_id: str) -> dict:
    request = VoiceRequest(text=text, session_id=session_id)
    response = await process_voice(request)
    return {
        "type": "voice_response",
        "text": response.text,
        "intent": response.intent,
        "confidence": response.confidence,
        "action": response.action,
        "requires_confirmation": response.requires_confirmation,
    }


async def execute_action(action_type: str, params: Dict[str, Any]) -> Dict[str, Any]:
    if action_type == "agent_execute":
        az = get_agent_zero_client()
        return await az.execute_task(params.get("prompt", ""), params.get("context"))

    return {"error": f"Unknown action: {action_type}"}


async def generate_llm_response(session_id: str, user_text: str) -> str:
    history = conversation_history.setdefault(session_id, [])
    history.append({"role": "user", "content": user_text})
    history[:] = history[-12:]

    if OPENROUTER_API_KEY:
        reply = await _call_openrouter(history)
    elif ZAI_API_KEY:
        reply = await _call_zai(history)
    else:
        reply = _fallback_chat(user_text)

    history.append({"role": "assistant", "content": reply})
    history[:] = history[-12:]
    return reply


async def _call_openrouter(history: List[Dict[str, str]]) -> str:
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": OPENROUTER_MODEL,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}] + history,
    }
    try:
        response = await llm_client.post(
            f"{OPENROUTER_BASE_URL}/chat/completions",
            headers=headers,
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        return _extract_chat_content(data) or "I received that. What should I do next?"
    except httpx.HTTPStatusError as exc:
        detail = _safe_error_detail(exc.response)
        return f"OpenRouter request failed ({exc.response.status_code}). {detail}".strip()
    except Exception as exc:
        return f"OpenRouter request failed: {exc}"


async def _call_zai(history: List[Dict[str, str]]) -> str:
    headers = {
        "Authorization": f"Bearer {ZAI_API_KEY}",
        "Content-Type": "application/json",
        "Accept-Language": "en-US,en",
    }
    payload = {
        "model": ZAI_MODEL,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}] + history,
    }
    try:
        response = await llm_client.post(
            f"{ZAI_BASE_URL}/chat/completions",
            headers=headers,
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        return _extract_chat_content(data) or "I received that. What should I do next?"
    except httpx.HTTPStatusError as exc:
        detail = _safe_error_detail(exc.response)
        return f"Z.AI request failed ({exc.response.status_code}). {detail}".strip()
    except Exception as exc:
        return f"Z.AI request failed: {exc}"


def _extract_chat_content(data: Dict[str, Any]) -> str:
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    message = choices[0].get("message", {})
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        texts = [part.get("text", "") for part in content if isinstance(part, dict)]
        return "\n".join(t for t in texts if t).strip()
    return ""


def _safe_error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
        if isinstance(payload, dict):
            for key in ("error", "message", "detail"):
                value = payload.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
                if isinstance(value, dict):
                    nested = value.get("message")
                    if isinstance(nested, str) and nested.strip():
                        return nested.strip()
        text = response.text.strip()
        return text[:200] if text else ""
    except Exception:
        return ""


def _fallback_chat(user_text: str) -> str:
    if "hello" in user_text.lower() or "hi" in user_text.lower():
        return "Hello. What do you want to work on?"
    return "I got it. Set OPENROUTER_API_KEY or ZAI_API_KEY for full model responses."


async def transcribe_audio_bytes(audio_bytes: bytes, filename: str) -> str:
    if not ZAI_API_KEY:
        raise RuntimeError("Transcription unavailable: ZAI_API_KEY is not configured")

    content_type = guess_type(filename)[0] or "application/octet-stream"
    headers = {
        "Authorization": f"Bearer {ZAI_API_KEY}",
    }
    data = {"model": ZAI_ASR_MODEL, "stream": "false"}
    files = {"file": (filename, audio_bytes, content_type)}

    try:
        response = await llm_client.post(
            f"{ZAI_BASE_URL}/audio/transcriptions",
            headers=headers,
            data=data,
            files=files,
        )
        response.raise_for_status()
        payload = response.json()
        text = payload.get("text", "")
        return text.strip() if isinstance(text, str) else ""
    except httpx.HTTPStatusError as exc:
        detail = _safe_error_detail(exc.response)
        log.warning(
            "Z.AI transcription failed status=%s detail=%s content_type=%s filename=%s bytes=%s",
            exc.response.status_code,
            detail,
            content_type,
            filename,
            len(audio_bytes),
        )
        raise RuntimeError(f"Z.AI transcription failed ({exc.response.status_code}). {detail}".strip())
    except Exception as exc:
        raise RuntimeError(f"Z.AI transcription failed: {exc}")


def generate_response(text: str, intent: str, entities: Dict[str, Any]) -> str:
    if intent == "COMMAND":
        action = entities.get("action", "")
        if "agent" in action:
            return "I'll execute that task via Agent Zero. Please confirm."
        return "Ready to execute command. Please confirm."

    if "hello" in text or "hi" in text:
        return "Hello! How can I assist you today?"

    if "help" in text:
        return "I can execute tasks via Agent Zero and track progress. What would you like to run?"

    return "I understand. How can I help you with that?"


@app.get("/health")
async def health():
    return {"status": "healthy", "timestamp": datetime.utcnow().isoformat()}


@app.get("/")
async def root():
    return {"message": "Voice Interface API v2.1 (Agent Zero)", "docs": "/docs"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
