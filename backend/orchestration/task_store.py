"""Task storage backends for orchestration state persistence."""

from __future__ import annotations

import os
from abc import ABC, abstractmethod
from typing import Dict, List, Optional

from .models import TaskRecord, TaskStatus


class TaskStore(ABC):
    """Abstract storage interface for task records."""

    @abstractmethod
    async def upsert_task(self, task: TaskRecord) -> None:
        """Create or update a task record."""

    @abstractmethod
    async def get_task(self, task_id: str) -> Optional[TaskRecord]:
        """Fetch a single task by id."""

    @abstractmethod
    async def list_tasks(
        self,
        *,
        conversation_id: str,
        status: Optional[TaskStatus] = None,
        limit: int = 20,
    ) -> List[TaskRecord]:
        """List tasks for a conversation ordered by created time desc."""

    @abstractmethod
    async def list_active_tasks(self) -> List[TaskRecord]:
        """List non-terminal tasks for restart recovery."""

    @abstractmethod
    async def close(self) -> None:
        """Release resources held by the storage backend."""


class InMemoryTaskStore(TaskStore):
    """Volatile in-memory task store used as fallback."""

    def __init__(self):
        self._tasks: Dict[str, TaskRecord] = {}

    async def upsert_task(self, task: TaskRecord) -> None:
        self._tasks[task.task_id] = task.model_copy(deep=True)

    async def get_task(self, task_id: str) -> Optional[TaskRecord]:
        task = self._tasks.get(task_id)
        return task.model_copy(deep=True) if task else None

    async def list_tasks(
        self,
        *,
        conversation_id: str,
        status: Optional[TaskStatus] = None,
        limit: int = 20,
    ) -> List[TaskRecord]:
        tasks = [
            task.model_copy(deep=True)
            for task in self._tasks.values()
            if task.conversation_id == conversation_id
            and (status is None or task.status == status)
        ]
        tasks.sort(key=lambda task: task.created_at, reverse=True)
        return tasks[:limit]

    async def list_active_tasks(self) -> List[TaskRecord]:
        active = [
            task.model_copy(deep=True)
            for task in self._tasks.values()
            if task.status
            not in {TaskStatus.SUCCEEDED, TaskStatus.FAILED, TaskStatus.CANCELED}
        ]
        active.sort(key=lambda task: task.created_at)
        return active

    async def close(self) -> None:
        return


class RedisTaskStore(TaskStore):
    """Redis-backed task persistence with conversation and active indexes."""

    def __init__(self, redis_url: str, prefix: str = "orchestrator"):
        try:
            from redis import asyncio as redis_asyncio  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise RuntimeError("redis package is required for RedisTaskStore") from exc

        self._redis = redis_asyncio.from_url(redis_url, decode_responses=True)
        self._prefix = prefix

    def _task_key(self, task_id: str) -> str:
        return f"{self._prefix}:task:{task_id}"

    def _conversation_index_key(self, conversation_id: str) -> str:
        return f"{self._prefix}:conversation:{conversation_id}:tasks"

    @property
    def _active_index_key(self) -> str:
        return f"{self._prefix}:tasks:active"

    async def upsert_task(self, task: TaskRecord) -> None:
        task_json = task.model_dump_json()
        score = float(task.created_at.timestamp())

        pipeline = self._redis.pipeline()
        pipeline.set(self._task_key(task.task_id), task_json)
        pipeline.zadd(
            self._conversation_index_key(task.conversation_id), {task.task_id: score}
        )

        if task.status in {
            TaskStatus.SUCCEEDED,
            TaskStatus.FAILED,
            TaskStatus.CANCELED,
        }:
            pipeline.srem(self._active_index_key, task.task_id)
        else:
            pipeline.sadd(self._active_index_key, task.task_id)

        await pipeline.execute()

    async def get_task(self, task_id: str) -> Optional[TaskRecord]:
        payload = await self._redis.get(self._task_key(task_id))
        if not payload:
            return None
        return TaskRecord.model_validate_json(payload)

    async def list_tasks(
        self,
        *,
        conversation_id: str,
        status: Optional[TaskStatus] = None,
        limit: int = 20,
    ) -> List[TaskRecord]:
        results: List[TaskRecord] = []
        start = 0
        step = max(limit * 3, 30)

        while len(results) < limit:
            task_ids = await self._redis.zrevrange(
                self._conversation_index_key(conversation_id), start, start + step - 1
            )
            if not task_ids:
                break

            payloads = await self._redis.mget(
                [self._task_key(task_id) for task_id in task_ids]
            )
            for payload in payloads:
                if not payload:
                    continue
                task = TaskRecord.model_validate_json(payload)
                if status is not None and task.status != status:
                    continue
                results.append(task)
                if len(results) >= limit:
                    break

            start += step

        return results[:limit]

    async def list_active_tasks(self) -> List[TaskRecord]:
        task_ids = list(await self._redis.smembers(self._active_index_key))
        if not task_ids:
            return []

        payloads = await self._redis.mget(
            [self._task_key(task_id) for task_id in task_ids]
        )
        tasks = [
            TaskRecord.model_validate_json(payload) for payload in payloads if payload
        ]
        tasks.sort(key=lambda task: task.created_at)
        return tasks

    async def close(self) -> None:
        await self._redis.aclose()


def build_task_store_from_env() -> TaskStore:
    """Select task store backend from env.

    TASK_STORE options:
    - memory (default)
    - redis
    """

    mode = os.environ.get("TASK_STORE", "memory").strip().lower()
    if mode == "redis":
        redis_url = os.environ.get("REDIS_URL")
        if not redis_url:
            raise RuntimeError("TASK_STORE=redis requires REDIS_URL")
        prefix = os.environ.get("TASK_REDIS_PREFIX", "orchestrator")
        return RedisTaskStore(redis_url=redis_url, prefix=prefix)

    return InMemoryTaskStore()
