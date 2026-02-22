"""
OpenClaw Integration - Security tools execution
"""
import os
from typing import Dict, Any, Optional, List
from datetime import datetime
import httpx
from pydantic import BaseModel

class OpenClawTool(BaseModel):
    name: str
    description: str
    category: str
    parameters: Dict[str, Any]

class OpenClawIntegration:
    """OpenClaw API client for security tools."""
    
    def __init__(self, base_url: Optional[str] = None, api_key: Optional[str] = None):
        self.base_url = base_url or os.environ.get("OPENCLAW_URL", "http://localhost:8080")
        self.api_key = api_key or os.environ.get("OPENCLAW_API_KEY")
        self.client = httpx.AsyncClient(timeout=120.0)
    
    def _get_headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["X-API-Key"] = self.api_key
        return headers
    
    async def list_tools(self) -> List[OpenClawTool]:
        """List available security tools."""
        try:
            response = await self.client.get(
                f"{self.base_url}/api/tools",
                headers=self._get_headers(),
            )
            response.raise_for_status()
            tools = response.json().get("tools", [])
            return [OpenClawTool(**t) for t in tools]
        except:
            # Return simulated tools
            return [
                OpenClawTool(name="nmap", description="Network scanner", category="recon", parameters={}),
                OpenClawTool(name="nikto", description="Web vulnerability scanner", category="web", parameters={}),
                OpenClawTool(name="gobuster", description="Directory bruteforcer", category="web", parameters={}),
            ]
    
    async def execute_tool(self, tool_name: str, target: str, options: Optional[Dict] = None) -> Dict[str, Any]:
        """Execute a security tool."""
        payload = {
            "tool": tool_name,
            "target": target,
            "options": options or {},
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
                "status": "simulated",
                "tool": tool_name,
                "target": target,
                "result": f"[Simulated] {tool_name} scan on {target} completed",
            }
    
    async def get_scan_status(self, scan_id: str) -> Dict[str, Any]:
        """Get status of a running scan."""
        response = await self.client.get(
            f"{self.base_url}/api/scan/{scan_id}",
            headers=self._get_headers(),
        )
        response.raise_for_status()
        return response.json()
    
    async def health_check(self) -> bool:
        """Check if OpenClaw is available."""
        try:
            response = await self.client.get(f"{self.base_url}/health", timeout=5.0)
            return response.status_code == 200
        except:
            return False
    
    async def close(self):
        """Close the HTTP client."""
        await self.client.aclose()

# Singleton
openclaw_client: Optional[OpenClawIntegration] = None

def get_openclaw_client() -> OpenClawIntegration:
    global openclaw_client
    if openclaw_client is None:
        openclaw_client = OpenClawIntegration()
    return openclaw_client
