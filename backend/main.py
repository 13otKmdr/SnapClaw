"""Voice Interface Backend - FastAPI Server (Agent Zero only)."""
from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from auth import (
    Token,
    UserCreate,
    UserLogin,
    api_keys_db,
    authenticate_user,
    create_access_token,
    create_api_key,
    create_user,
    get_current_user,
    verify_api_key,
)
from integrations.agent_zero import get_agent_zero_client
from orchestration import handle_realtime_proxy, shutdown_orchestration
from orchestration.routes import router as orchestration_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Voice Interface Backend starting...")
    yield
    print("Shutting down...")
    az = get_agent_zero_client()
    await az.close()
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


bearer_scheme = HTTPBearer(auto_error=False)


async def get_api_key_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    api_key: str = Query(None),
) -> Optional[Dict[str, Any]]:
    if credentials:
        token = credentials.credentials
        if token.startswith("vi_"):
            return verify_api_key(token)
        user = await get_current_user(credentials)
        if user:
            return {"user_id": user.id, "username": user.username}

    if api_key:
        return verify_api_key(api_key)

    return None


@app.post("/api/auth/register", response_model=Token, tags=["Auth"])
async def register(user_data: UserCreate):
    for user in api_keys_db.values():
        if user.get("email") == user_data.email:
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

    response_text = generate_response(text, intent, entities)

    return VoiceResponse(
        text=response_text,
        intent=intent,
        confidence=confidence,
        action=action,
        requires_confirmation=requires_confirmation,
        entities=entities,
    )


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
