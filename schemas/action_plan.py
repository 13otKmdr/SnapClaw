"""
Action Plan Schema - Core data structures for voice command execution
"""
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any, Literal, Union
from datetime import datetime
import uuid


class ActionTarget(BaseModel):
    """Target system for an action."""
    system: Literal["telegram", "agent_zero", "openclaw"]
    resource: str = Field(..., description="e.g., chat_id, agent_id, tool_name")
    action: str = Field(..., description="e.g., send_message, execute_task")


class ActionStep(BaseModel):
    """Single step in an action plan."""
    tool: str
    input: Dict[str, Any]
    expected_output: Optional[str] = None
    timeout_ms: int = 30000


class RollbackStep(BaseModel):
    """Rollback step for undo operations."""
    tool: str
    input: Dict[str, Any]


class UserFeedback(BaseModel):
    """Voice feedback configuration."""
    spoken_ack: str = Field(..., description="Immediate voice acknowledgment")
    spoken_result: str = Field(..., description="Final result to speak")
    brief_text_log: str = Field(..., description="Short log entry")


class ActionPlan(BaseModel):
    """Complete action plan for voice command execution."""
    mode: Literal["CHAT", "COMMAND"]
    confidence: float = Field(..., ge=0.0, le=1.0)
    intent: str = Field(..., description="Canonical intent name")
    targets: List[ActionTarget] = []
    parameters: Dict[str, Any] = {}
    requires_confirmation: bool = False
    confirmation_prompt: Optional[str] = None
    steps: List[ActionStep] = []
    rollback: List[RollbackStep] = []
    user_feedback: UserFeedback
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    trace_id: str = Field(default_factory=lambda: str(uuid.uuid4()))

    class Config:
        json_schema_extra = {
            "examples": [
                {
                    "mode": "COMMAND",
                    "confidence": 0.95,
                    "intent": "telegram_send_message",
                    "targets": [{"system": "telegram", "resource": "chat_id:123456789", "action": "send_message"}],
                    "parameters": {"recipient_name": "John", "message": "Hello!"},
                    "requires_confirmation": False,
                    "steps": [{"tool": "telegram_send", "input": {"chat_id": 123456789, "text": "Hello!"}}],
                    "user_feedback": {"spoken_ack": "Sending", "spoken_result": "Sent", "brief_text_log": "TG→John"}
                }
            ]
        }


class IntentResult(BaseModel):
    """Result of intent classification."""
    mode: Literal["CHAT", "COMMAND", "AMBIGUOUS"]
    confidence: float
    intent: Optional[str] = None
    entities: Dict[str, Any] = {}
    raw_transcript: str = ""


class ToolResult(BaseModel):
    """Result from tool execution."""
    tool_name: str
    success: bool
    output: Optional[Any] = None
    error: Optional[str] = None
    duration_ms: int = 0


class ExecutionResult(BaseModel):
    """Complete execution result with audit info."""
    trace_id: str
    action_plan: ActionPlan
    tool_results: List[ToolResult] = []
    overall_success: bool
    error: Optional[str] = None
    confirmation_given: bool = False
    total_duration_ms: int = 0
    timestamp: datetime = Field(default_factory=datetime.utcnow)
