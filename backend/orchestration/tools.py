"""Realtime tool definitions and dispatcher for Agent Zero task orchestration."""

from __future__ import annotations

import json
from typing import Any, Dict, List

from pydantic import ValidationError

from .models import (
    CancelTaskInput,
    CheckTaskStatusInput,
    CreateTaskInput,
    ListTasksInput,
    UpdateTaskInput,
)
from .task_manager import TaskManager


def build_realtime_tool_specs() -> List[Dict[str, Any]]:
    """OpenAI Realtime function tool schema list."""

    return [
        {
            "type": "function",
            "name": "create_task",
            "description": "Create a new asynchronous Agent Zero task from a user goal.",
            "parameters": {
                "type": "object",
                "properties": {
                    "goal": {
                        "type": "string",
                        "description": "Task objective to delegate.",
                    },
                    "context": {
                        "type": "string",
                        "description": "Optional additional context for execution.",
                    },
                    "priority": {
                        "type": "string",
                        "enum": ["low", "normal", "high"],
                        "description": "Task urgency.",
                    },
                    "metadata": {
                        "type": "object",
                        "description": "Optional structured metadata for task routing.",
                    },
                },
                "required": ["goal"],
                "additionalProperties": False,
            },
        },
        {
            "type": "function",
            "name": "list_tasks",
            "description": "List known tasks for the current conversation.",
            "parameters": {
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "enum": [
                            "queued",
                            "running",
                            "waiting_input",
                            "succeeded",
                            "failed",
                            "canceled",
                        ],
                        "description": "Optional status filter.",
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 100,
                        "description": "Maximum number of tasks to return.",
                    },
                },
                "additionalProperties": False,
            },
        },
        {
            "type": "function",
            "name": "check_task_status",
            "description": "Get latest status and result for a task.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "Local task id returned by create_task.",
                    },
                },
                "required": ["task_id"],
                "additionalProperties": False,
            },
        },
        {
            "type": "function",
            "name": "update_task",
            "description": "Send updated instructions to an in-flight task.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "string", "description": "Local task id."},
                    "instruction": {
                        "type": "string",
                        "description": "New direction to apply.",
                    },
                },
                "required": ["task_id", "instruction"],
                "additionalProperties": False,
            },
        },
        {
            "type": "function",
            "name": "cancel_task",
            "description": "Cancel an existing task.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "string", "description": "Local task id."},
                },
                "required": ["task_id"],
                "additionalProperties": False,
            },
        },
    ]


class OrchestrationToolRouter:
    """Dispatch function calls from Realtime API to task manager operations."""

    def __init__(self, task_manager: TaskManager):
        self._task_manager = task_manager

    async def handle_tool_call(
        self,
        *,
        name: str,
        arguments: Any,
        conversation_id: str,
    ) -> Dict[str, Any]:
        try:
            parsed_args = self._parse_arguments(arguments)

            if name == "create_task":
                payload = CreateTaskInput.model_validate(parsed_args)
                task = await self._task_manager.create_task(
                    conversation_id=conversation_id,
                    goal=payload.goal,
                    context=payload.context,
                    priority=payload.priority,
                    metadata=payload.metadata,
                )
                return {"ok": True, "task": task.model_dump(mode="json")}

            if name == "list_tasks":
                payload = ListTasksInput.model_validate(parsed_args)
                tasks = await self._task_manager.list_tasks(
                    conversation_id=conversation_id,
                    status=payload.status,
                    limit=payload.limit,
                )
                return {
                    "ok": True,
                    "tasks": [task.model_dump(mode="json") for task in tasks],
                }

            if name == "check_task_status":
                payload = CheckTaskStatusInput.model_validate(parsed_args)
                task = await self._task_manager.refresh_task_status(payload.task_id)
                if not task:
                    return {"ok": False, "error": f"Task '{payload.task_id}' not found"}
                return {"ok": True, "task": task.model_dump(mode="json")}

            if name == "update_task":
                payload = UpdateTaskInput.model_validate(parsed_args)
                task = await self._task_manager.update_task(
                    payload.task_id, payload.instruction
                )
                if not task:
                    return {"ok": False, "error": f"Task '{payload.task_id}' not found"}
                return {"ok": True, "task": task.model_dump(mode="json")}

            if name == "cancel_task":
                payload = CancelTaskInput.model_validate(parsed_args)
                task = await self._task_manager.cancel_task(payload.task_id)
                if not task:
                    return {"ok": False, "error": f"Task '{payload.task_id}' not found"}
                return {"ok": True, "task": task.model_dump(mode="json")}

            return {"ok": False, "error": f"Unsupported tool '{name}'"}

        except ValidationError as exc:
            return {
                "ok": False,
                "error": "Invalid tool arguments",
                "details": exc.errors(),
            }
        except Exception as exc:
            return {
                "ok": False,
                "error": f"Tool execution failed: {exc}",
            }

    def _parse_arguments(self, arguments: Any) -> Dict[str, Any]:
        if arguments is None:
            return {}
        if isinstance(arguments, dict):
            return arguments
        if isinstance(arguments, str):
            if not arguments.strip():
                return {}
            parsed = json.loads(arguments)
            if not isinstance(parsed, dict):
                raise ValueError("Tool arguments must decode to an object")
            return parsed
        raise ValueError("Unsupported tool arguments type")
