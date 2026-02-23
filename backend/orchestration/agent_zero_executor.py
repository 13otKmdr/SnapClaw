"""Agent Zero executor interface with HTTP and mock implementations."""
from __future__ import annotations

import asyncio
import os
import uuid
from abc import ABC, abstractmethod
from typing import Any, Dict, Optional
from urllib.parse import quote

import httpx

from .models import ExternalTaskState, TaskPriority, TaskStatus


_STATUS_MAP = {
    "pending": TaskStatus.QUEUED,
    "queued": TaskStatus.QUEUED,
    "created": TaskStatus.QUEUED,
    "running": TaskStatus.RUNNING,
    "in_progress": TaskStatus.RUNNING,
    "processing": TaskStatus.RUNNING,
    "waiting_input": TaskStatus.WAITING_INPUT,
    "requires_input": TaskStatus.WAITING_INPUT,
    "blocked": TaskStatus.WAITING_INPUT,
    "completed": TaskStatus.SUCCEEDED,
    "done": TaskStatus.SUCCEEDED,
    "success": TaskStatus.SUCCEEDED,
    "succeeded": TaskStatus.SUCCEEDED,
    "failed": TaskStatus.FAILED,
    "error": TaskStatus.FAILED,
    "canceled": TaskStatus.CANCELED,
    "cancelled": TaskStatus.CANCELED,
}


def _normalize_status(value: Any, default: TaskStatus = TaskStatus.RUNNING) -> TaskStatus:
    if isinstance(value, TaskStatus):
        return value
    if value is None:
        return default
    key = str(value).strip().lower()
    return _STATUS_MAP.get(key, default)


def _extract_result(payload: Dict[str, Any]) -> Any:
    for key in ("result", "output", "message", "data"):
        if key in payload and payload[key] is not None:
            return payload[key]
    return None


class AgentZeroExecutor(ABC):
    """Abstract async interface for Agent Zero task operations."""

    @abstractmethod
    async def create_task(
        self,
        *,
        goal: str,
        context: Optional[str],
        priority: TaskPriority,
        metadata: Dict[str, Any],
    ) -> ExternalTaskState:
        """Create a new task and return normalized state."""

    @abstractmethod
    async def get_task_status(self, external_task_id: str) -> ExternalTaskState:
        """Get the latest status for an external task."""

    @abstractmethod
    async def cancel_task(self, external_task_id: str) -> bool:
        """Cancel an external task."""

    @abstractmethod
    async def update_task(self, external_task_id: str, instruction: str) -> Optional[ExternalTaskState]:
        """Update a running task, if supported by backend."""

    @abstractmethod
    async def close(self) -> None:
        """Release any underlying resources."""


class HttpAgentZeroExecutor(AgentZeroExecutor):
    """HTTP executor against an Agent Zero API."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: Optional[str] = None,
        timeout_seconds: float = 30.0,
        create_path: str = "/api/task",
        status_path: str = "/api/task/{task_id}",
        cancel_path: str = "/api/task/{task_id}",
        update_path: str = "/api/task/{task_id}",
        execute_fallback_path: Optional[str] = "/api/execute",
    ):
        self.base_url = base_url.rstrip("/")
        self.create_path = create_path
        self.status_path = status_path
        self.cancel_path = cancel_path
        self.update_path = update_path
        self.execute_fallback_path = execute_fallback_path
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        self.client = httpx.AsyncClient(base_url=self.base_url, headers=headers, timeout=timeout_seconds)

    def _format_path(self, template: str, task_id: Optional[str] = None) -> str:
        if "{task_id}" not in template:
            return template
        if task_id is None:
            raise ValueError("task_id is required for this path template")
        return template.replace("{task_id}", quote(task_id, safe=""))

    async def _request_json(self, method: str, path: str, *, json_body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        response = await self.client.request(method, path, json=json_body)
        response.raise_for_status()
        payload = response.json()
        if isinstance(payload, dict):
            return payload
        return {"data": payload}

    async def create_task(
        self,
        *,
        goal: str,
        context: Optional[str],
        priority: TaskPriority,
        metadata: Dict[str, Any],
    ) -> ExternalTaskState:
        payload = {
            "prompt": goal,
            "context": context,
            "priority": priority,
            "metadata": metadata,
        }

        data: Dict[str, Any]
        try:
            data = await self._request_json("POST", self.create_path, json_body=payload)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 404 or not self.execute_fallback_path:
                raise
            fallback_payload = {"prompt": goal, "context": context}
            data = await self._request_json("POST", self.execute_fallback_path, json_body=fallback_payload)

        external_task_id = str(data.get("task_id") or data.get("id") or uuid.uuid4())
        status = _normalize_status(data.get("status"), default=TaskStatus.RUNNING)
        return ExternalTaskState(
            external_task_id=external_task_id,
            status=status,
            result=_extract_result(data),
            error=data.get("error"),
            raw=data,
        )

    async def get_task_status(self, external_task_id: str) -> ExternalTaskState:
        path = self._format_path(self.status_path, external_task_id)
        data = await self._request_json("GET", path)
        return ExternalTaskState(
            external_task_id=str(data.get("task_id") or data.get("id") or external_task_id),
            status=_normalize_status(data.get("status"), default=TaskStatus.RUNNING),
            result=_extract_result(data),
            error=data.get("error"),
            raw=data,
        )

    async def cancel_task(self, external_task_id: str) -> bool:
        path = self._format_path(self.cancel_path, external_task_id)
        response = await self.client.delete(path)
        if response.status_code in (200, 202, 204):
            return True

        if response.status_code == 405:
            cancel_path = f"{path.rstrip('/')}/cancel"
            fallback = await self.client.post(cancel_path)
            return fallback.status_code in (200, 202, 204)

        return False

    async def update_task(self, external_task_id: str, instruction: str) -> Optional[ExternalTaskState]:
        path = self._format_path(self.update_path, external_task_id)
        payload = {"instruction": instruction}

        response = await self.client.patch(path, json=payload)
        if response.status_code == 404:
            fallback = await self.client.post(f"{path.rstrip('/')}/update", json=payload)
            if fallback.status_code == 404:
                return None
            fallback.raise_for_status()
            data = fallback.json()
        else:
            response.raise_for_status()
            data = response.json()

        if not isinstance(data, dict):
            return None

        return ExternalTaskState(
            external_task_id=str(data.get("task_id") or data.get("id") or external_task_id),
            status=_normalize_status(data.get("status"), default=TaskStatus.RUNNING),
            result=_extract_result(data),
            error=data.get("error"),
            raw=data,
        )

    async def close(self) -> None:
        await self.client.aclose()


class MockAgentZeroExecutor(AgentZeroExecutor):
    """In-memory simulator used for local development/testing."""

    def __init__(self, completion_delay_seconds: float = 5.0):
        self.completion_delay_seconds = completion_delay_seconds
        self._tasks: Dict[str, Dict[str, Any]] = {}
        self._lock = asyncio.Lock()
        self._background_tasks: set[asyncio.Task] = set()

    async def create_task(
        self,
        *,
        goal: str,
        context: Optional[str],
        priority: TaskPriority,
        metadata: Dict[str, Any],
    ) -> ExternalTaskState:
        external_task_id = f"mock_{uuid.uuid4().hex[:12]}"
        task = {
            "task_id": external_task_id,
            "status": TaskStatus.RUNNING,
            "goal": goal,
            "context": context,
            "priority": priority,
            "metadata": metadata,
            "updates": [],
            "result": None,
            "error": None,
        }
        async with self._lock:
            self._tasks[external_task_id] = task

        simulator = asyncio.create_task(self._finish_task(external_task_id))
        self._background_tasks.add(simulator)
        simulator.add_done_callback(self._background_tasks.discard)

        return ExternalTaskState(
            external_task_id=external_task_id,
            status=TaskStatus.RUNNING,
            raw=task,
        )

    async def _finish_task(self, external_task_id: str) -> None:
        await asyncio.sleep(self.completion_delay_seconds)
        async with self._lock:
            task = self._tasks.get(external_task_id)
            if not task or task.get("status") == TaskStatus.CANCELED:
                return

            update_summary = ""
            if task["updates"]:
                update_summary = f" Latest update: {task['updates'][-1]}"

            task["status"] = TaskStatus.SUCCEEDED
            task["result"] = (
                f"[Mock Agent Zero] Completed task '{task['goal']}'."
                f" Priority: {task['priority']}."
                f"{update_summary}"
            )

    async def get_task_status(self, external_task_id: str) -> ExternalTaskState:
        async with self._lock:
            task = self._tasks.get(external_task_id)
            if not task:
                return ExternalTaskState(
                    external_task_id=external_task_id,
                    status=TaskStatus.FAILED,
                    error="Task not found",
                    raw={},
                )
            snapshot = dict(task)

        return ExternalTaskState(
            external_task_id=external_task_id,
            status=_normalize_status(snapshot.get("status"), default=TaskStatus.RUNNING),
            result=snapshot.get("result"),
            error=snapshot.get("error"),
            raw=snapshot,
        )

    async def cancel_task(self, external_task_id: str) -> bool:
        async with self._lock:
            task = self._tasks.get(external_task_id)
            if not task:
                return False
            task["status"] = TaskStatus.CANCELED
            task["result"] = None
            task["error"] = None
        return True

    async def update_task(self, external_task_id: str, instruction: str) -> Optional[ExternalTaskState]:
        async with self._lock:
            task = self._tasks.get(external_task_id)
            if not task:
                return None
            task["updates"].append(instruction)
            if task["status"] not in (TaskStatus.SUCCEEDED, TaskStatus.FAILED, TaskStatus.CANCELED):
                task["status"] = TaskStatus.RUNNING
            snapshot = dict(task)

        return ExternalTaskState(
            external_task_id=external_task_id,
            status=_normalize_status(snapshot.get("status"), default=TaskStatus.RUNNING),
            result=snapshot.get("result"),
            error=snapshot.get("error"),
            raw=snapshot,
        )

    async def close(self) -> None:
        for task in list(self._background_tasks):
            task.cancel()
        if self._background_tasks:
            await asyncio.gather(*self._background_tasks, return_exceptions=True)
        self._background_tasks.clear()


def build_agent_zero_executor_from_env() -> AgentZeroExecutor:
    """Build executor implementation from environment variables."""

    mode = os.environ.get("AGENT_ZERO_EXECUTOR", "http").strip().lower()
    if mode == "mock":
        delay = float(os.environ.get("AGENT_ZERO_MOCK_DELAY_SECONDS", "5"))
        return MockAgentZeroExecutor(completion_delay_seconds=delay)

    return HttpAgentZeroExecutor(
        base_url=os.environ.get("AGENT_ZERO_URL", "http://localhost:50001"),
        api_key=os.environ.get("AGENT_ZERO_API_KEY"),
        timeout_seconds=float(os.environ.get("AGENT_ZERO_TIMEOUT_SECONDS", "30")),
        create_path=os.environ.get("AGENT_ZERO_CREATE_PATH", "/api/task"),
        status_path=os.environ.get("AGENT_ZERO_STATUS_PATH", "/api/task/{task_id}"),
        cancel_path=os.environ.get("AGENT_ZERO_CANCEL_PATH", "/api/task/{task_id}"),
        update_path=os.environ.get("AGENT_ZERO_UPDATE_PATH", "/api/task/{task_id}"),
        execute_fallback_path=os.environ.get("AGENT_ZERO_EXECUTE_FALLBACK_PATH", "/api/execute"),
    )
