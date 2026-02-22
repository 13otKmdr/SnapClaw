"""
OpenClaw Adapter - HTTP/WebSocket client for OpenClaw agent orchestration
"""
from pydantic import BaseModel
from typing import Optional, List, Dict, Any, Literal
from datetime import datetime
from enum import Enum
import httpx
import asyncio
import json


class OpenClawAction(str, Enum):
    EXECUTE_TOOL = "execute_tool"
    ORCHESTRATE_AGENTS = "orchestrate_agents"
    GET_CAPABILITIES = "get_capabilities"
    SUBSCRIBE_EVENTS = "subscribe_events"


class OpenClawTarget(BaseModel):
    agent_pool: Optional[str] = "default"
    priority: Literal["low", "normal", "high"] = "normal"
    timeout_ms: int = 30000


class OpenClawToolCall(BaseModel):
    tool_name: str
    parameters: Dict[str, Any]
    expected_output: Optional[str] = None


class OpenClawRequest(BaseModel):
    action: OpenClawAction
    target: OpenClawTarget
    tool_calls: List[OpenClawToolCall] = []
    workflow_id: Optional[str] = None
    parallel: bool = False


class OpenClawToolResult(BaseModel):
    tool_name: str
    success: bool
    output: Optional[Any] = None
    error: Optional[str] = None
    duration_ms: int = 0


class OpenClawResponse(BaseModel):
    success: bool
    execution_id: Optional[str] = None
    results: List[OpenClawToolResult] = []
    error: Optional[str] = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class OpenClawAdapter:
    """Async HTTP/WebSocket client for OpenClaw."""

    def __init__(self, ws_url: str, http_url: str, auth_token: Optional[str] = None):
        self.ws_url = ws_url
        self.http_url = http_url
        self.auth_token = auth_token
        self.headers = {"Authorization": f"Bearer {auth_token}"} if auth_token else {}
        self._client: Optional[httpx.AsyncClient] = None
        self._ws = None

    async def initialize(self):
        """Initialize HTTP client."""
        self._client = httpx.AsyncClient(
            base_url=self.http_url,
            headers=self.headers,
            timeout=60.0
        )

    async def close(self):
        """Close HTTP client and WebSocket."""
        if self._client:
            await self._client.aclose()
        if self._ws:
            await self._ws.close()

    async def connect_websocket(self) -> bool:
        """Establish WebSocket connection for event streaming."""
        try:
            import websockets
            headers = {"Authorization": f"Bearer {self.auth_token}"} if self.auth_token else {}
            self._ws = await websockets.connect(self.ws_url, extra_headers=headers)
            return True
        except Exception as e:
            print(f"WebSocket connection failed: {e}")
            return False

    async def execute_tool(self, request: OpenClawRequest) -> OpenClawResponse:
        """Execute tool(s) via HTTP API."""
        if not self._client:
            await self.initialize()

        try:
            payload = {
                "action": request.action.value,
                "target": request.target.model_dump(),
                "tool_calls": [tc.model_dump() for tc in request.tool_calls],
                "workflow_id": request.workflow_id,
                "parallel": request.parallel
            }

            response = await self._client.post("/api/execute", json=payload)
            response.raise_for_status()
            data = response.json()

            results = [
                OpenClawToolResult(
                    tool_name=r.get("tool_name", ""),
                    success=r.get("success", False),
                    output=r.get("output"),
                    error=r.get("error"),
                    duration_ms=r.get("duration_ms", 0)
                )
                for r in data.get("results", [])
            ]

            return OpenClawResponse(
                success=data.get("success", False),
                execution_id=data.get("execution_id"),
                results=results,
                error=data.get("error")
            )
        except Exception as e:
            return OpenClawResponse(
                success=False,
                error=str(e)
            )

    async def get_capabilities(self) -> List[Dict[str, Any]]:
        """Get available tools and agents."""
        if not self._client:
            await self.initialize()

        response = await self._client.get("/api/capabilities")
        response.raise_for_status()
        return response.json().get("tools", [])

    async def stream_events(self):
        """Subscribe to event stream via WebSocket."""
        if not self._ws:
            await self.connect_websocket()

        async for message in self._ws:
            yield json.loads(message)
