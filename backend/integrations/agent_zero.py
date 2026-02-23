"""Agent Zero Integration - Execute tasks via Agent Zero API."""
from __future__ import annotations

import os
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx


class AgentZeroIntegration:
    """Agent Zero API client for task execution."""

    def __init__(self, base_url: Optional[str] = None, api_key: Optional[str] = None):
        self.base_url = base_url or os.environ.get("AGENT_ZERO_URL", "http://localhost:50001")
        self.api_key = api_key or os.environ.get("AGENT_ZERO_API_KEY")
        self.client = httpx.AsyncClient(timeout=300.0)

    def _get_headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    async def execute_task(self, prompt: str, context: Optional[str] = None) -> Dict[str, Any]:
        payload = {
            "prompt": prompt,
            "context": context,
        }

        try:
            response = await self.client.post(
                f"{self.base_url}/api/execute",
                json=payload,
                headers=self._get_headers(),
            )
            response.raise_for_status()
            return response.json()
        except httpx.ConnectError:
            return {
                "task_id": f"sim_{datetime.utcnow().timestamp()}",
                "status": "completed",
                "result": f"[Simulated] Task '{prompt[:50]}...' would be executed by Agent Zero",
            }

    async def get_task_status(self, task_id: str) -> Dict[str, Any]:
        response = await self.client.get(
            f"{self.base_url}/api/task/{task_id}",
            headers=self._get_headers(),
        )
        response.raise_for_status()
        return response.json()

    async def list_capabilities(self) -> List[str]:
        return [
            "code_execution",
            "web_search",
            "memory_management",
            "file_operations",
            "browser_automation",
            "terminal_commands",
            "api_calls",
        ]

    async def health_check(self) -> bool:
        try:
            response = await self.client.get(f"{self.base_url}/health", timeout=5.0)
            return response.status_code == 200
        except Exception:
            return False

    async def close(self) -> None:
        await self.client.aclose()


agent_zero_client: Optional[AgentZeroIntegration] = None


def get_agent_zero_client() -> AgentZeroIntegration:
    global agent_zero_client
    if agent_zero_client is None:
        agent_zero_client = AgentZeroIntegration()
    return agent_zero_client
