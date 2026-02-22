"""
Voice Interface Backend - FastAPI Server
With Authentication, SSL, and Real Integrations
"""
import os
from datetime import datetime
from typing import Dict, Any, Optional, List
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Depends, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
import asyncio
import json

# Import integrations
from integrations.telegram import TelegramIntegration, get_telegram_client
from integrations.agent_zero import AgentZeroIntegration, get_agent_zero_client
from integrations.openclaw import OpenClawIntegration, get_openclaw_client

# Import auth
from auth import (
    User, UserCreate, UserLogin, Token,
    create_user, authenticate_user, create_access_token,
    get_current_user, create_api_key, verify_api_key, api_keys_db
)

# Configuration
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
AGENT_ZERO_URL = os.environ.get("AGENT_ZERO_URL", "http://localhost:50001")
OPENCLAW_URL = os.environ.get("OPENCLAW_URL", "http://localhost:8080")
JWT_SECRET = os.environ.get("JWT_SECRET_KEY", "change-me-in-production")

# Lifespan manager
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    print("🚀 Voice Interface Backend starting...")
    yield
    # Shutdown
    print("👋 Shutting down...")
    tg = get_telegram_client()
    az = get_agent_zero_client()
    oc = get_openclaw_client()
    await tg.close()
    await az.close()
    await oc.close()

# Create app
app = FastAPI(
    title="Voice Interface API",
    description="Voice-first AI assistant with Telegram, Agent Zero, and OpenClaw integration",
    version="2.0.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# WebSocket manager
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
    
    async def connect(self, session_id: str, websocket: WebSocket):
        await websocket.accept()
        self.active_connections[session_id] = websocket
    
    def disconnect(self, session_id: str):
        if session_id in self.active_connections:
            del self.active_connections[session_id]
    
    async def send_json(self, session_id: str, data: dict):
        if session_id in self.active_connections:
            await self.active_connections[session_id].send_json(data)
    
    async def broadcast(self, data: dict):
        for ws in self.active_connections.values():
            await ws.send_json(data)

manager = ConnectionManager()

# Models
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

class TelegramSendRequest(BaseModel):
    chat_id: int
    text: str
    parse_mode: str = "Markdown"

# API Key authentication
bearer_scheme = HTTPBearer(auto_error=False)

async def get_api_key_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    api_key: str = Query(None),
) -> Optional[Dict]:
    # Try Bearer token first
    if credentials:
        token = credentials.credentials
        # Check if it's an API key
        if token.startswith("vi_"):
            return verify_api_key(token)
        # Otherwise try JWT
        user = await get_current_user(credentials)
        if user:
            return {"user_id": user.id, "username": user.username}
    # Try query param
    if api_key:
        return verify_api_key(api_key)
    return None

# ============ AUTH ENDPOINTS ============

@app.post("/api/auth/register", response_model=Token, tags=["Auth"])
async def register(user_data: UserCreate):
    """Register a new user."""
    # Check if email exists
    for user in api_keys_db.values():
        if user.get("email") == user_data.email:
            raise HTTPException(400, "Email already registered")
    
    user = create_user(user_data.email, user_data.username, user_data.password)
    token = create_access_token({"sub": user.id, "email": user.email})
    
    return Token(
        access_token=token,
        user={"id": user.id, "email": user.email, "username": user.username}
    )

@app.post("/api/auth/login", response_model=Token, tags=["Auth"])
async def login(credentials: UserLogin):
    """Login and get JWT token."""
    user = authenticate_user(credentials.email, credentials.password)
    if not user:
        raise HTTPException(401, "Invalid credentials")
    
    token = create_access_token({"sub": user.id, "email": user.email})
    
    return Token(
        access_token=token,
        user={"id": user.id, "email": user.email, "username": user.username}
    )

@app.post("/api/auth/api-keys", tags=["Auth"])
async def create_new_api_key(
    name: str,
    current_user: Dict = Depends(get_api_key_user),
):
    """Create a new API key."""
    if not current_user:
        raise HTTPException(401, "Authentication required")
    
    key = create_api_key(current_user["user_id"], name)
    return {"api_key": key, "name": name}

@app.get("/api/auth/me", tags=["Auth"])
async def get_me(current_user: Dict = Depends(get_api_key_user)):
    """Get current user info."""
    if not current_user:
        raise HTTPException(401, "Not authenticated")
    return current_user

# ============ VOICE ENDPOINTS ============

@app.post("/api/voice/process", response_model=VoiceResponse, tags=["Voice"])
async def process_voice(
    request: VoiceRequest,
    user: Optional[Dict] = Depends(get_api_key_user),
):
    """Process voice input and return response."""
    text = request.text.lower()
    
    # Simple intent classification
    intent = "CHAT"
    confidence = 0.9
    entities = {}
    action = None
    requires_confirmation = False
    
    # Check for commands
    if any(word in text for word in ["send", "telegram", "message"]):
        intent = "COMMAND"
        entities["action"] = "telegram_send"
        requires_confirmation = True
        action = {"type": "telegram_send", "status": "pending"}
    
    elif any(word in text for word in ["execute", "run", "agent zero"]):
        intent = "COMMAND"
        entities["action"] = "agent_execute"
        requires_confirmation = True
        action = {"type": "agent_execute", "status": "pending"}
    
    elif any(word in text for word in ["scan", "nmap", "security"]):
        intent = "COMMAND"
        entities["action"] = "openclaw_scan"
        requires_confirmation = True
        action = {"type": "openclaw_scan", "status": "pending"}
    
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
    user: Optional[Dict] = Depends(get_api_key_user),
):
    """Confirm and execute a pending action."""
    if not confirmed:
        return {"status": "cancelled", "message": "Action cancelled"}
    
    result = await execute_action(action_type, params)
    return {"status": "completed", "result": result}

# ============ TELEGRAM ENDPOINTS ============

@app.get("/api/telegram/dialogs", tags=["Telegram"])
async def get_telegram_dialogs(user: Optional[Dict] = Depends(get_api_key_user)):
    """Get list of Telegram chats/dialogs."""
    tg = get_telegram_client()
    try:
        dialogs = await tg.get_dialogs()
        return {"dialogs": dialogs}
    except Exception as e:
        raise HTTPException(500, f"Telegram error: {str(e)}")

@app.get("/api/telegram/chat/{chat_id}", tags=["Telegram"])
async def get_telegram_chat(chat_id: int, user: Optional[Dict] = Depends(get_api_key_user)):
    """Get Telegram chat info."""
    tg = get_telegram_client()
    try:
        chat = await tg.get_chat(chat_id)
        return chat
    except Exception as e:
        raise HTTPException(500, f"Telegram error: {str(e)}")

@app.post("/api/telegram/send", tags=["Telegram"])
async def send_telegram_message(
    request: TelegramSendRequest,
    user: Optional[Dict] = Depends(get_api_key_user),
):
    """Send a message via Telegram."""
    tg = get_telegram_client()
    try:
        result = await tg.send_message(request.chat_id, request.text, request.parse_mode)
        return {"status": "sent", "message_id": result.get("message_id")}
    except Exception as e:
        raise HTTPException(500, f"Telegram error: {str(e)}")

# ============ AGENT ZERO ENDPOINTS ============

@app.post("/api/agent/execute", tags=["Agent Zero"])
async def execute_agent_task(
    request: CommandRequest,
    user: Optional[Dict] = Depends(get_api_key_user),
):
    """Execute a task via Agent Zero."""
    az = get_agent_zero_client()
    try:
        result = await az.execute_task(request.command, request.params.get("context"))
        return result
    except Exception as e:
        raise HTTPException(500, f"Agent Zero error: {str(e)}")

@app.get("/api/agent/capabilities", tags=["Agent Zero"])
async def get_agent_capabilities(user: Optional[Dict] = Depends(get_api_key_user)):
    """Get Agent Zero capabilities."""
    az = get_agent_zero_client()
    return await az.list_capabilities()

@app.get("/api/agent/health", tags=["Agent Zero"])
async def agent_health():
    """Check Agent Zero connection."""
    az = get_agent_zero_client()
    is_healthy = await az.health_check()
    return {"healthy": is_healthy}

# ============ OPENCLAW ENDPOINTS ============

@app.get("/api/openclaw/tools", tags=["OpenClaw"])
async def get_openclaw_tools(user: Optional[Dict] = Depends(get_api_key_user)):
    """Get available security tools."""
    oc = get_openclaw_client()
    return await oc.list_tools()

@app.post("/api/openclaw/execute", tags=["OpenClaw"])
async def execute_openclaw_tool(
    request: CommandRequest,
    user: Optional[Dict] = Depends(get_api_key_user),
):
    """Execute a security tool via OpenClaw."""
    oc = get_openclaw_client()
    try:
        result = await oc.execute_tool(request.command, request.target, request.params)
        return result
    except Exception as e:
        raise HTTPException(500, f"OpenClaw error: {str(e)}")

# ============ WEBSOCKET ============

@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    await manager.connect(session_id, websocket)
    try:
        while True:
            data = await websocket.receive_json()
            
            # Process voice input
            if data.get("type") == "voice_input":
                text = data.get("text", "")
                response = await process_voice_input(text, session_id)
                await manager.send_json(session_id, response)
            
            # Execute action
            elif data.get("type") == "execute":
                action_type = data.get("action")
                params = data.get("params", {})
                result = await execute_action(action_type, params)
                await manager.send_json(session_id, {
                    "type": "action_result",
                    "action": action_type,
                    "result": result,
                })
    
    except WebSocketDisconnect:
        manager.disconnect(session_id)

async def process_voice_input(text: str, session_id: str) -> dict:
    """Process voice input via WebSocket."""
    # Use the main process_voice logic
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
    """Execute an action."""
    if action_type == "telegram_send":
        tg = get_telegram_client()
        return await tg.send_message(
            params.get("chat_id"),
            params.get("text"),
        )
    
    elif action_type == "agent_execute":
        az = get_agent_zero_client()
        return await az.execute_task(params.get("prompt"))
    
    elif action_type == "openclaw_scan":
        oc = get_openclaw_client()
        return await oc.execute_tool(
            params.get("tool", "nmap"),
            params.get("target"),
        )
    
    return {"error": f"Unknown action: {action_type}"}

def generate_response(text: str, intent: str, entities: Dict) -> str:
    """Generate a conversational response."""
    if intent == "COMMAND":
        action = entities.get("action", "")
        if "telegram" in action:
            return "I'll send that message via Telegram. Please confirm."
        elif "agent" in action:
            return "I'll execute that task via Agent Zero. Please confirm."
        elif "scan" in action:
            return "I'll run that security scan. Please confirm."
        return "Ready to execute command. Please confirm."
    
    # Chat responses
    if "hello" in text or "hi" in text:
        return "Hello! How can I assist you today?"
    elif "help" in text:
        return "I can help you send Telegram messages, execute tasks via Agent Zero, or run security scans. What would you like to do?"
    
    return "I understand. How can I help you with that?"

# Health check
@app.get("/health")
async def health():
    return {"status": "healthy", "timestamp": datetime.utcnow().isoformat()}

@app.get("/")
async def root():
    return {"message": "Voice Interface API v2.0", "docs": "/docs"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
