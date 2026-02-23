"""
Agent Zero adapter.

Send path  : POST /api_message  (X-API-KEY header, blocks until response)
Stream path: Socket.IO  state_push  events on the same host
             → yields log lines from snapshot["logs"] as they arrive

Agent Zero API reference (from repo):
  POST /api_message
    headers: X-API-KEY: <token>
    body:    { message, context_id, lifetime_hours }
    returns: { context_id, response }

  Socket.IO state_push payload (relevant fields):
    snapshot.logs          — list of new log entries since last push
    snapshot.log_progress  — string when working, 0 when idle
"""
import asyncio
import logging
from typing import AsyncGenerator

import httpx
import socketio

from .base import AgentAdapter
from ..config import settings

log = logging.getLogger(__name__)


class AgentZeroAdapter(AgentAdapter):

    def __init__(self) -> None:
        self._base = settings.agent_zero_url.rstrip("/")
        self._key = settings.agent_zero_api_key
        self._headers = {
            "X-API-KEY": self._key,
            "Content-Type": "application/json",
        }

    # ------------------------------------------------------------------
    # send_message
    # ------------------------------------------------------------------

    async def send_message(
        self,
        text: str,
        context_id: str | None = None,
    ) -> tuple[str, str]:
        """
        POST /api_message — blocks until Agent Zero finishes.
        Timeout is generous (300 s) because agent tasks can be long.
        """
        payload: dict = {
            "message": text,
            "lifetime_hours": 72,
        }
        if context_id:
            payload["context_id"] = context_id

        async with httpx.AsyncClient(timeout=300.0) as client:
            resp = await client.post(
                f"{self._base}/api_message",
                json=payload,
                headers=self._headers,
            )
            resp.raise_for_status()
            data = resp.json()

        response_text: str = data.get("response", "")
        returned_ctx: str = data.get("context_id", context_id or "")
        return response_text, returned_ctx

    # ------------------------------------------------------------------
    # stream_updates
    # ------------------------------------------------------------------

    async def stream_updates(
        self,
        context_id: str,
    ) -> AsyncGenerator[str, None]:
        """
        Connect to Agent Zero's Socket.IO and yield log lines
        from state_push events until the agent goes idle.

        Agent Zero pushes snapshot["log_progress"] as a string while
        working and 0 (falsy) when done.  We yield each new log entry
        and stop when we see log_progress become falsy and no new logs
        for > 2 s.
        """
        queue: asyncio.Queue[str | None] = asyncio.Queue()
        loop = asyncio.get_event_loop()

        sio = socketio.AsyncClient(
            reconnection=False,
            logger=False,
            engineio_logger=False,
        )

        last_log_version: int = -1
        idle_since: float | None = None

        @sio.event
        async def connect():
            # Ask for current state so we get the initial snapshot
            await sio.emit(
                "state_request",
                {
                    "context": context_id,
                    "log_from": 0,
                    "notifications_from": 0,
                    "timezone": "UTC",
                },
            )

        @sio.on("state_push")
        async def on_state_push(data: dict):
            nonlocal last_log_version, idle_since

            snapshot = data.get("snapshot", {})
            logs: list = snapshot.get("logs", [])
            log_version: int = snapshot.get("log_version", last_log_version)
            progress = snapshot.get("log_progress", 0)
            is_active: bool = bool(snapshot.get("log_progress_active", False))

            # Only process new log entries
            if log_version > last_log_version:
                last_log_version = log_version
                for entry in logs:
                    # Each log entry is a dict; grab the text content
                    content = _extract_log_text(entry)
                    if content:
                        await queue.put(content)

            # Detect idle: progress went falsy and hasn't been active recently
            if not is_active and not progress:
                if idle_since is None:
                    idle_since = loop.time()
                # Give it 2 s of quiet before we declare done
                if loop.time() - idle_since > 2.0:
                    await queue.put(None)  # sentinel
            else:
                idle_since = None

        @sio.event
        async def disconnect():
            await queue.put(None)  # sentinel

        # Connect — Agent Zero uses Socket.IO over HTTP (not HTTPS for local)
        try:
            await sio.connect(
                self._base,
                auth={"csrf_token": ""},   # no CSRF needed for API-key auth
                transports=["websocket"],
                wait_timeout=10,
            )
        except Exception as exc:
            log.warning("Could not connect to Agent Zero Socket.IO for streaming: %s", exc)
            return

        try:
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=30.0)
                except asyncio.TimeoutError:
                    # No update in 30 s — give up
                    break
                if item is None:
                    break
                yield item
        finally:
            await sio.disconnect()

    # ------------------------------------------------------------------
    # health_check
    # ------------------------------------------------------------------

    async def health_check(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self._base}/health")
                return resp.status_code == 200
        except Exception:
            return False


# ------------------------------------------------------------------
# helpers
# ------------------------------------------------------------------

def _extract_log_text(entry: dict | str) -> str:
    """Pull readable text out of an Agent Zero log entry."""
    if isinstance(entry, str):
        return entry.strip()
    if isinstance(entry, dict):
        # Agent Zero log entries look like:
        # { "type": "...", "content": "...", "heading": "..." }
        content = entry.get("content") or entry.get("heading") or entry.get("text") or ""
        if isinstance(content, list):
            # sometimes content is a list of sub-items
            parts = []
            for item in content:
                if isinstance(item, dict):
                    parts.append(item.get("text") or item.get("content") or "")
                elif isinstance(item, str):
                    parts.append(item)
            content = " ".join(p for p in parts if p)
        return str(content).strip()
    return ""
