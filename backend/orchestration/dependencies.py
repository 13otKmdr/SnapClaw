"""Singleton dependency wiring for orchestration components."""

from __future__ import annotations

import os
from typing import Optional

from .agent_zero_executor import build_agent_zero_executor_from_env
from .task_manager import TaskManager
from .task_store import build_task_store_from_env
from .tools import OrchestrationToolRouter

_task_manager: Optional[TaskManager] = None
_tool_router: Optional[OrchestrationToolRouter] = None


def get_task_manager() -> TaskManager:
    global _task_manager
    if _task_manager is None:
        executor = build_agent_zero_executor_from_env()
        task_store = build_task_store_from_env()
        poll_interval = float(os.environ.get("TASK_POLL_INTERVAL_SECONDS", "2"))
        max_poll_errors = int(os.environ.get("TASK_MAX_POLL_ERRORS", "5"))
        _task_manager = TaskManager(
            executor,
            task_store,
            poll_interval_seconds=poll_interval,
            max_poll_errors=max_poll_errors,
        )
    return _task_manager


def get_tool_router() -> OrchestrationToolRouter:
    global _tool_router
    if _tool_router is None:
        _tool_router = OrchestrationToolRouter(get_task_manager())
    return _tool_router


async def shutdown_orchestration() -> None:
    global _task_manager, _tool_router
    if _task_manager is not None:
        await _task_manager.shutdown()
    _task_manager = None
    _tool_router = None
