"""Async task manager for orchestrating Agent Zero work from a realtime assistant."""
from __future__ import annotations

import asyncio
import uuid
from typing import Dict, List, Optional, Set

from .agent_zero_executor import AgentZeroExecutor
from .models import (
    TERMINAL_TASK_STATUSES,
    ExternalTaskState,
    TaskEvent,
    TaskEventKind,
    TaskPriority,
    TaskRecord,
    TaskStatus,
    utcnow,
)
from .task_store import TaskStore


class TaskManager:
    """Coordinates task lifecycle, persistence, polling, and event fanout."""

    def __init__(
        self,
        executor: AgentZeroExecutor,
        task_store: TaskStore,
        *,
        poll_interval_seconds: float = 2.0,
        max_poll_errors: int = 5,
    ):
        self._executor = executor
        self._task_store = task_store
        self._poll_interval_seconds = poll_interval_seconds
        self._max_poll_errors = max_poll_errors
        self._lock = asyncio.Lock()
        self._tasks_cache: Dict[str, TaskRecord] = {}
        self._subscribers: Dict[str, Set[asyncio.Queue[TaskEvent]]] = {}
        self._pollers: Dict[str, asyncio.Task] = {}
        self._background_jobs: Set[asyncio.Task] = set()
        self._initialized = False
        self._closed = False

    async def initialize(self) -> None:
        """Load persisted active tasks and resume background tracking."""
        await self._ensure_initialized()

    async def create_task(
        self,
        *,
        conversation_id: str,
        goal: str,
        context: Optional[str] = None,
        priority: TaskPriority = "normal",
        metadata: Optional[dict] = None,
    ) -> TaskRecord:
        await self._ensure_initialized()

        now = utcnow()
        task = TaskRecord(
            task_id=f"task_{uuid.uuid4().hex[:12]}",
            conversation_id=conversation_id,
            goal=goal,
            context=context,
            priority=priority,
            status=TaskStatus.QUEUED,
            metadata=metadata or {},
            created_at=now,
            updated_at=now,
        )

        async with self._lock:
            if self._closed:
                raise RuntimeError("Task manager is shut down")
            self._tasks_cache[task.task_id] = task.model_copy(deep=True)

        await self._task_store.upsert_task(task)
        await self._publish(TaskEventKind.CREATED, task)
        await self._enqueue_submission(task.task_id)

        return task

    async def get_task(self, task_id: str) -> Optional[TaskRecord]:
        await self._ensure_initialized()

        async with self._lock:
            cached = self._tasks_cache.get(task_id)
            if cached:
                return cached.model_copy(deep=True)

        task = await self._task_store.get_task(task_id)
        if not task:
            return None

        if task.status not in TERMINAL_TASK_STATUSES:
            async with self._lock:
                self._tasks_cache[task.task_id] = task.model_copy(deep=True)

        return task.model_copy(deep=True)

    async def list_tasks(
        self,
        *,
        conversation_id: str,
        status: Optional[TaskStatus] = None,
        limit: int = 20,
    ) -> List[TaskRecord]:
        await self._ensure_initialized()
        return await self._task_store.list_tasks(conversation_id=conversation_id, status=status, limit=limit)

    async def refresh_task_status(self, task_id: str) -> Optional[TaskRecord]:
        task = await self.get_task(task_id)
        if not task:
            return None

        if task.status in TERMINAL_TASK_STATUSES or not task.external_task_id:
            return task

        external = await self._executor.get_task_status(task.external_task_id)
        await self._apply_external_state(task_id, external)
        return await self.get_task(task_id)

    async def update_task(self, task_id: str, instruction: str) -> Optional[TaskRecord]:
        task = await self.get_task(task_id)
        if not task:
            return None

        task.updates.append(instruction)
        task.updated_at = utcnow()
        await self._save_task(task)
        await self._publish(TaskEventKind.UPDATED, task)

        if task.external_task_id and task.status not in TERMINAL_TASK_STATUSES:
            try:
                external = await self._executor.update_task(task.external_task_id, instruction)
                if external:
                    await self._apply_external_state(task_id, external)
            except Exception as exc:
                await self._mark_failed(task_id, f"Failed to update remote task: {exc}")

        return await self.get_task(task_id)

    async def cancel_task(self, task_id: str) -> Optional[TaskRecord]:
        task = await self.get_task(task_id)
        if not task:
            return None

        if task.status in TERMINAL_TASK_STATUSES:
            return task

        if task.external_task_id:
            try:
                await self._executor.cancel_task(task.external_task_id)
            except Exception:
                # Local cancellation still proceeds if remote cancellation fails.
                pass

        task.status = TaskStatus.CANCELED
        task.error = None
        task.result = None
        task.completed_at = utcnow()
        task.updated_at = utcnow()

        await self._save_task(task)
        await self._publish(TaskEventKind.CANCELED, task)
        return task

    async def subscribe(self, conversation_id: str) -> asyncio.Queue[TaskEvent]:
        queue: asyncio.Queue[TaskEvent] = asyncio.Queue(maxsize=100)
        async with self._lock:
            self._subscribers.setdefault(conversation_id, set()).add(queue)
        return queue

    async def unsubscribe(self, conversation_id: str, queue: asyncio.Queue[TaskEvent]) -> None:
        async with self._lock:
            subscribers = self._subscribers.get(conversation_id)
            if not subscribers:
                return
            subscribers.discard(queue)
            if not subscribers:
                self._subscribers.pop(conversation_id, None)

    async def shutdown(self) -> None:
        async with self._lock:
            self._closed = True
            tasks = list(self._pollers.values()) + list(self._background_jobs)
            self._pollers.clear()
            self._background_jobs.clear()

        for task in tasks:
            task.cancel()

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        await self._executor.close()
        await self._task_store.close()

    async def _ensure_initialized(self) -> None:
        async with self._lock:
            if self._initialized:
                return
            if self._closed:
                raise RuntimeError("Task manager is shut down")

        active_tasks = await self._task_store.list_active_tasks()

        async with self._lock:
            if self._initialized:
                return
            for task in active_tasks:
                self._tasks_cache[task.task_id] = task.model_copy(deep=True)
            self._initialized = True

        for task in active_tasks:
            if task.status in TERMINAL_TASK_STATUSES:
                continue
            if task.external_task_id:
                await self._start_poller(task.task_id)
            else:
                await self._enqueue_submission(task.task_id)

    async def _enqueue_submission(self, task_id: str) -> None:
        async with self._lock:
            if self._closed:
                return

        runner = asyncio.create_task(self._submit_task(task_id))
        async with self._lock:
            self._background_jobs.add(runner)
        runner.add_done_callback(self._background_jobs.discard)

    async def _start_poller(self, task_id: str) -> None:
        async with self._lock:
            if self._closed:
                return
            existing = self._pollers.get(task_id)
            if existing and not existing.done():
                return
            poller = asyncio.create_task(self._poll_task(task_id))
            self._pollers[task_id] = poller

        poller.add_done_callback(lambda _: self._pollers.pop(task_id, None))

    async def _save_task(self, task: TaskRecord) -> None:
        snapshot = task.model_copy(deep=True)

        async with self._lock:
            if snapshot.status in TERMINAL_TASK_STATUSES:
                self._tasks_cache.pop(snapshot.task_id, None)
            else:
                self._tasks_cache[snapshot.task_id] = snapshot

        await self._task_store.upsert_task(snapshot)

    async def _submit_task(self, task_id: str) -> None:
        snapshot = await self.get_task(task_id)
        if not snapshot:
            return

        if snapshot.status in TERMINAL_TASK_STATUSES:
            return

        if snapshot.external_task_id:
            await self._start_poller(task_id)
            return

        try:
            external = await self._executor.create_task(
                goal=snapshot.goal,
                context=snapshot.context,
                priority=snapshot.priority,
                metadata=snapshot.metadata,
            )
        except Exception as exc:
            await self._mark_failed(task_id, f"Failed to create remote task: {exc}")
            return

        await self._apply_external_state(task_id, external)

        latest = await self.get_task(task_id)
        if latest and latest.status not in TERMINAL_TASK_STATUSES and latest.external_task_id:
            await self._start_poller(task_id)

    async def _poll_task(self, task_id: str) -> None:
        consecutive_errors = 0

        while True:
            await asyncio.sleep(self._poll_interval_seconds)
            snapshot = await self.get_task(task_id)
            if not snapshot:
                return
            if snapshot.status in TERMINAL_TASK_STATUSES:
                return
            if not snapshot.external_task_id:
                continue

            try:
                external = await self._executor.get_task_status(snapshot.external_task_id)
            except Exception as exc:
                consecutive_errors += 1
                if consecutive_errors >= self._max_poll_errors:
                    await self._mark_failed(task_id, f"Status polling failed repeatedly: {exc}")
                    return
                continue

            consecutive_errors = 0
            await self._apply_external_state(task_id, external)

    async def _apply_external_state(self, task_id: str, external: ExternalTaskState) -> None:
        task = await self.get_task(task_id)
        if not task:
            return

        before_status = task.status
        before_result = task.result
        before_error = task.error
        before_external_id = task.external_task_id

        task.external_task_id = external.external_task_id or task.external_task_id
        task.status = external.status
        if external.result is not None:
            task.result = external.result
        if external.error is not None:
            task.error = external.error
        task.updated_at = utcnow()

        if task.status in TERMINAL_TASK_STATUSES and task.completed_at is None:
            task.completed_at = utcnow()

        changed = (
            task.status != before_status
            or task.result != before_result
            or task.error != before_error
            or task.external_task_id != before_external_id
        )

        if not changed:
            return

        await self._save_task(task)

        if task.status == TaskStatus.SUCCEEDED:
            await self._publish(TaskEventKind.COMPLETED, task)
        elif task.status == TaskStatus.FAILED:
            await self._publish(TaskEventKind.FAILED, task)
        elif task.status == TaskStatus.CANCELED:
            await self._publish(TaskEventKind.CANCELED, task)
        else:
            await self._publish(TaskEventKind.UPDATED, task)
            if task.external_task_id:
                await self._start_poller(task.task_id)

    async def _mark_failed(self, task_id: str, error_message: str) -> None:
        task = await self.get_task(task_id)
        if not task:
            return

        task.status = TaskStatus.FAILED
        task.error = error_message
        task.updated_at = utcnow()
        task.completed_at = task.completed_at or utcnow()

        await self._save_task(task)
        await self._publish(TaskEventKind.FAILED, task)

    async def _publish(self, event_kind: TaskEventKind, task: TaskRecord) -> None:
        event = TaskEvent(type=event_kind, conversation_id=task.conversation_id, task=task)
        async with self._lock:
            subscribers = list(self._subscribers.get(task.conversation_id, set()))

        for queue in subscribers:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # Keep subscribers live by dropping oldest backlog item.
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    queue.put_nowait(event)
                except asyncio.QueueFull:
                    pass
