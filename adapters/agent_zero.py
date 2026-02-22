"""
Agent Zero Adapter - HTTP/WebSocket client for Agent Zero API
"""
from pydantic import BaseModel
from typing import Optional, List, Dict, Any, Literal
from datetime import datetime
from enum import Enum
import httpx
import asyncio
import json


class AgentZeroAction(str, Enum):
    EXECUTE_TASK = "execute_task"
    SPAWN_SUBORDINATE = "spawn_subordinate"
    CHECK_STATUS = "check_status"
    CANCEL_TASK = "cancel_task"
    GET_MEMORY = "get_memory"


class AgentZeroTarget(BaseModel):
    agent_id: Optional[str] = None
    profile: Optional[str] = None  # default, researcher, developer, hacker
    context_id: Optional[str] = None


class AgentZeroRequest(BaseModel):
    action: AgentZeroAction
    target: AgentZeroTarget
    prompt: str
    attachments: List[str] = []
    timeout_seconds: int = 300
    stream_response: bool = True


class AgentZeroTaskResult(BaseModel):
    task_id: str
    status: str  # pending, running, completed, failed
    result: Optional[str] = None
    error: Optional[str] = None
    tool_calls: List[Dict[str, Any]] = []
    started_at: datetime
    completed_at: Optional[datetime] = None


class AgentZeroResponse(BaseModel):
    success: bool
    task_id: Optional[str] = None
    result: Optional[AgentZeroTaskResult] = None
    error: Optional[str] = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class AgentZeroAdapter:
    """Async HTTP/WebSocket client for Agent Zero."""

    def __init__(self, base_url: str, api_key: Optional[str] = None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._client: Optional[httpx.AsyncClient] = None
        self._ws = None

    async def initialize(self):
        """Initialize HTTP client."""
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers=self.headers,
            timeout=60.0
        )

    async def close(self):
        """Close HTTP client."""
        if self._client:
            await self._client.aclose()

    async def execute_task(self, request: AgentZeroRequest) -> AgentZeroResponse:
        """Execute a task on Agent Zero."""
        if not self._client:
            await self.initialize()

        try:
            payload = {
                "prompt": request.prompt,
                "profile": request.target.profile or "default",
                "attachments": request.attachments,
                "timeout": request.timeout_seconds,
                "stream": request.stream_response
            }

            response = await self._client.post("/api/task", json=payload)
            response.raise_for_status()
            data = response.json()

            return AgentZeroResponse(
                success=True,
                task_id=data.get("task_id"),
                result=AgentZeroTaskResult(
                    task_id=data.get("task_id", ""),
                    status=data.get("status", "pending"),
                    result=data.get("result"),
                    started_at=datetime.utcnow()
                ) if data.get("task_id") else None
            )
        except Exception as e:
            return AgentZeroResponse(
                success=False,
                error=str(e)
            )

    async def check_status(self, task_id: str) -> AgentZeroTaskResult:
        """Check status of a running task."""
        if not self._client:
            await self.initialize()

        response = await self._client.get(f"/api/task/{task_id}")
        response.raise_for_status()
        data = response.json()

        return AgentZeroTaskResult(
            task_id=task_id,
            status=data.get("status", "unknown"),
            result=data.get("result"),
            error=data.get("error"),
            tool_calls=data.get("tool_calls", []),
            started_at=datetime.fromisoformat(data.get("started_at", datetime.utcnow().isoformat())),
            completed_at=datetime.fromisoformat(data["completed_at"]) if data.get("completed_at") else None
        )

    async def cancel_task(self, task_id: str) -> bool:
        """Cancel a running task."""
        if not self._client:
            await self.initialize()

        response = await self._client.delete(f"/api/task/{task_id}")
        return response.status_code == 200

    async def get_memory(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        """Search Agent Zero memory."""
        if not self._client:
            await self.initialize()

        response = await self._client.get("/api/memory", params={
            "query": query,
            "limit": limit
        })
        response.raise_for_status()
        return response.json().get("results", [])
