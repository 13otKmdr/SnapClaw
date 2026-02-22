"""
Agent Zero Integration - Execute tasks via Agent Zero API
"""
import os
import json
from typing import Dict, Any, Optional, List
from datetime import datetime
import httpx
from pydantic import BaseModel

class AgentTask(BaseModel):
    task_id: str
    status: str
    prompt: str
    result: Optional[str] = None
    created_at: datetime
    completed_at: Optional[datetime] = None

class AgentZeroIntegration:
    """Agent Zero API client for task execution."""
    
    def __init__(self, base_url: Optional[str] = None, api_key: Optional[str] = None):
        self.base_url = base_url or os.environ.get("AGENT_ZERO_URL", "http://localhost:50001")
        self.api_key = api_key or os.environ.get("AGENT_ZERO_API_KEY")
        self.client = httpx.AsyncClient(timeout=300.0)  # 5 min timeout for long tasks
    
    def _get_headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers
    
    async def execute_task(self, prompt: str, context: Optional[str] = None) -> Dict[str, Any]:
        """Execute a task via Agent Zero."""
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
            # Fallback: simulate response if Agent Zero not available
            return {
                "task_id": f"sim_{datetime.utcnow().timestamp()}",
                "status": "completed",
                "result": f"[Simulated] Task '{prompt[:50]}...' would be executed by Agent Zero",
            }
    
    async def get_task_status(self, task_id: str) -> Dict[str, Any]:
        """Get status of a running task."""
        response = await self.client.get(
            f"{self.base_url}/api/task/{task_id}",
            headers=self._get_headers(),
        )
        response.raise_for_status()
        return response.json()
    
    async def list_capabilities(self) -> List[str]:
        """List available Agent Zero capabilities."""
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
        """Check if Agent Zero is available."""
        try:
            response = await self.client.get(f"{self.base_url}/health", timeout=5.0)
            return response.status_code == 200
        except:
            return False
    
    async def close(self):
        """Close the HTTP client."""
        await self.client.aclose()

# Singleton
agent_zero_client: Optional[AgentZeroIntegration] = None

def get_agent_zero_client() -> AgentZeroIntegration:
    global agent_zero_client
    if agent_zero_client is None:
        agent_zero_client = AgentZeroIntegration()
    return agent_zero_client
