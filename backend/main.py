"""
Voice Interface Backend - FastAPI Server
Real-time voice processing with WebSocket support
"""
import os
import sys
import uuid
import json
import asyncio
from datetime import datetime
from typing import Dict, Any, Optional, List
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import APIKeyHeader
from pydantic import BaseModel
import uvicorn

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from engine.intent import IntentClassifier
from engine.policy import PolicyValidator
from schemas.action_plan import ActionPlan, IntentResult, ActionTarget, UserFeedback

# Initialize app
app = FastAPI(
    title="Voice Interface API",
    description="Real-time voice processing API with WebSocket support",
    version="1.0.0",
)

# CORS for mobile app
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict to your app's origin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Security
API_KEY_NAME = "X-API-Key"
api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)

# In-memory session storage (use Redis in production)
sessions: Dict[str, Dict[str, Any]] = {}

# WebSocket connection manager
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}

    async def connect(self, websocket: WebSocket, session_id: str):
        await websocket.accept()
        self.active_connections[session_id] = websocket

    def disconnect(self, session_id: str):
        if session_id in self.active_connections:
            del self.active_connections[session_id]

    async def send_json(self, session_id: str, data: dict):
        if session_id in self.active_connections:
            await self.active_connections[session_id].send_json(data)

    async def broadcast(self, message: str):
        for connection in self.active_connections.values():
            await connection.send_text(message)

manager = ConnectionManager()

# Initialize engine components
intent_classifier = IntentClassifier()
policy_validator = PolicyValidator()

# Pydantic models for API
class VoiceRequest(BaseModel):
    text: str
    session_id: Optional[str] = None

class ConfirmationRequest(BaseModel):
    session_id: str
    confirmed: bool

class VoiceResponse(BaseModel):
    mode: str
    confidence: float
    intent: Optional[str] = None
    response: str
    action_taken: bool = False
    action_result: Optional[str] = None
    requires_confirmation: bool = False
    confirmation_prompt: Optional[str] = None
    entities: Optional[Dict[str, Any]] = None

class SessionState(BaseModel):
    session_id: str
    messages: List[Dict[str, Any]] = []
    pending_action: Optional[Dict[str, Any]] = None
    created_at: str
    last_activity: str

# API key verification
async def verify_api_key(api_key: str = Depends(api_key_header)):
    valid_keys = os.environ.get("API_KEYS", "test-key").split(",")
    if api_key not in valid_keys:
        # For development, allow requests without API key
        pass
    return api_key

# Health check
@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "sessions": len(sessions),
        "connections": len(manager.active_connections),
    }

# REST API endpoints
@app.post("/api/voice/process", response_model=VoiceResponse)
async def process_voice(request: VoiceRequest, api_key: str = Depends(verify_api_key)):
    """Process voice input and return response"""
    session_id = request.session_id or str(uuid.uuid4())
    
    # Get or create session
    if session_id not in sessions:
        sessions[session_id] = {
            "session_id": session_id,
            "messages": [],
            "pending_action": None,
            "created_at": datetime.utcnow().isoformat(),
            "last_activity": datetime.utcnow().isoformat(),
        }
    
    session = sessions[session_id]
    session["last_activity"] = datetime.utcnow().isoformat()
    
    # Add user message to history
    session["messages"].append({
        "role": "user",
        "content": request.text,
        "timestamp": datetime.utcnow().isoformat(),
    })
    
    # Classify intent
    result = intent_classifier.classify(request.text)
    
    # Build response based on classification
    if result.mode == "COMMAND":
        action_plan = {
            "mode": "COMMAND",
            "confidence": result.confidence,
            "intent": result.intent,
            "targets": [],
            "parameters": result.entities,
            "requires_confirmation": policy_validator.requires_confirmation(
                {"parameters": result.entities, "targets": []}
            ),
        }
        
        # Get confirmation prompt if needed
        if action_plan["requires_confirmation"]:
            confirmation_prompt = policy_validator.get_confirmation_prompt(action_plan)
            session["pending_action"] = action_plan
            
            return VoiceResponse(
                mode="COMMAND",
                confidence=result.confidence,
                intent=result.intent,
                response=f"I want to {result.intent.replace('_', ' ')}. Should I proceed?",
                requires_confirmation=True,
                confirmation_prompt=confirmation_prompt,
                entities=result.entities,
            )
        
        # Execute the command (simulated for now)
        action_result = await execute_action(action_plan)
        
        response_text = action_result.get("response", f"Done! I've processed your {result.intent} request.")
        
        # Add assistant message to history
        session["messages"].append({
            "role": "assistant",
            "content": response_text,
            "timestamp": datetime.utcnow().isoformat(),
            "action_taken": True,
            "action_result": action_result.get("result"),
        })
        
        return VoiceResponse(
            mode="COMMAND",
            confidence=result.confidence,
            intent=result.intent,
            response=response_text,
            action_taken=True,
            action_result=action_result.get("result"),
            entities=result.entities,
        )
    
    elif result.mode == "AMBIGUOUS":
        # Ask for clarification
        return VoiceResponse(
            mode="AMBIGUOUS",
            confidence=result.confidence,
            response="I'm not sure what you mean. Could you please be more specific?",
            entities=result.entities,
        )
    
    else:  # CHAT
        # Generate conversational response
        response_text = await generate_chat_response(request.text, session)
        
        # Add assistant message to history
        session["messages"].append({
            "role": "assistant",
            "content": response_text,
            "timestamp": datetime.utcnow().isoformat(),
        })
        
        return VoiceResponse(
            mode="CHAT",
            confidence=result.confidence,
            response=response_text,
        )

@app.post("/api/voice/confirm", response_model=VoiceResponse)
async def confirm_action(request: ConfirmationRequest, api_key: str = Depends(verify_api_key)):
    """Confirm or cancel a pending action"""
    session_id = request.session_id
    
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session = sessions[session_id]
    pending = session.get("pending_action")
    
    if not pending:
        raise HTTPException(status_code=400, detail="No pending action to confirm")
    
    if request.confirmed:
        # Execute the action
        action_result = await execute_action(pending)
        response_text = action_result.get("response", "Action completed successfully.")
        
        session["messages"].append({
            "role": "assistant",
            "content": response_text,
            "timestamp": datetime.utcnow().isoformat(),
            "action_taken": True,
            "action_result": action_result.get("result"),
        })
    else:
        response_text = "Action cancelled."
        session["messages"].append({
            "role": "assistant",
            "content": response_text,
            "timestamp": datetime.utcnow().isoformat(),
        })
    
    # Clear pending action
    session["pending_action"] = None
    
    return VoiceResponse(
        mode="COMMAND",
        confidence=1.0,
        intent=pending.get("intent"),
        response=response_text,
        action_taken=request.confirmed,
        action_result=action_result.get("result") if request.confirmed else None,
    )

@app.get("/api/voice/history/{session_id}")
async def get_history(session_id: str, api_key: str = Depends(verify_api_key)):
    """Get conversation history for a session"""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    return {
        "session_id": session_id,
        "messages": sessions[session_id]["messages"],
    }

# WebSocket endpoint
@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    """WebSocket endpoint for real-time communication"""
    await manager.connect(websocket, session_id)
    
    # Create session if not exists
    if session_id not in sessions:
        sessions[session_id] = {
            "session_id": session_id,
            "messages": [],
            "pending_action": None,
            "created_at": datetime.utcnow().isoformat(),
            "last_activity": datetime.utcnow().isoformat(),
        }
    
    try:
        while True:
            data = await websocket.receive_json()
            
            # Handle different message types
            message_type = data.get("type", "voice_input")
            
            if message_type == "voice_input":
                text = data.get("text", "")
                
                # Send transcript update
                await manager.send_json(session_id, {
                    "type": "transcript",
                    "text": text,
                })
                
                # Process the input
                request = VoiceRequest(text=text, session_id=session_id)
                response = await process_voice(request, None)
                
                # Send response
                await manager.send_json(session_id, {
                    "type": "response",
                    **response.model_dump(),
                })
            
            elif message_type == "confirm_action":
                confirmed = data.get("confirmed", False)
                request = ConfirmationRequest(session_id=session_id, confirmed=confirmed)
                response = await confirm_action(request, None)
                
                await manager.send_json(session_id, {
                    "type": "response",
                    **response.model_dump(),
                })
    
    except WebSocketDisconnect:
        manager.disconnect(session_id)
    except Exception as e:
        print(f"WebSocket error: {e}")
        manager.disconnect(session_id)

# Helper functions
async def execute_action(action_plan: Dict[str, Any]) -> Dict[str, Any]:
    """Execute an action plan (connect to real adapters)"""
    intent = action_plan.get("intent", "")
    params = action_plan.get("parameters", {})
    
    # Simulated execution for MVP
    # In production, connect to real Telegram/AgentZero/OpenClaw adapters
    
    if intent == "telegram_send_message":
        recipient = params.get("recipient", "unknown")
        message = params.get("message", "")
        return {
            "response": f"Message sent to {recipient}.",
            "result": f"Telegram → {recipient}: {message[:50]}...",
        }
    
    elif intent == "telegram_read_messages":
        chat = params.get("chat", "recent")
        return {
            "response": f"You have 3 new messages in {chat}.",
            "result": "3 messages read",
        }
    
    elif intent == "agent_zero_execute":
        task = params.get("task", "unknown task")
        return {
            "response": f"I've started working on: {task}",
            "result": f"Agent Zero task started",
        }
    
    elif intent == "openclaw_execute":
        tool = params.get("tool", "unknown tool")
        return {
            "response": f"Executing {tool} via OpenClaw.",
            "result": "OpenClaw execution started",
        }
    
    else:
        return {
            "response": f"I've processed your request.",
            "result": "Action completed",
        }

async def generate_chat_response(text: str, session: Dict[str, Any]) -> str:
    """Generate a conversational response"""
    # In production, connect to LLM (Ollama, OpenAI, etc.)
    
    # Simple responses for MVP
    text_lower = text.lower()
    
    if "hello" in text_lower or "hi " in text_lower:
        return "Hello! How can I help you today?"
    
    if "how are you" in text_lower:
        return "I'm doing well, thank you for asking! What can I do for you?"
    
    if "thank" in text_lower:
        return "You're welcome! Is there anything else I can help with?"
    
    if "time" in text_lower:
        return f"The current time is {datetime.utcnow().strftime('%H:%M UTC')}"
    
    if "date" in text_lower or "day" in text_lower:
        return f"Today is {datetime.utcnow().strftime('%A, %B %d, %Y')}"
    
    # Default response
    return "I'm here to help! You can ask me to send messages on Telegram, execute tasks with Agent Zero, or run tools via OpenClaw. What would you like to do?"

# Run server
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
