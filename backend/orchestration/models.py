"""Shared models for Realtime orchestration and async Agent Zero task management."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field

TaskPriority = Literal["low", "normal", "high"]


class TaskStatus(str, Enum):
    """Canonical task statuses surfaced to the voice orchestrator."""

    QUEUED = "queued"
    RUNNING = "running"
    WAITING_INPUT = "waiting_input"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELED = "canceled"


TERMINAL_TASK_STATUSES = {
    TaskStatus.SUCCEEDED,
    TaskStatus.FAILED,
    TaskStatus.CANCELED,
}


def utcnow() -> datetime:
    """Return timezone-aware UTC timestamp for API payloads and storage."""

    return datetime.now(timezone.utc)


class TaskEventKind(str, Enum):
    CREATED = "task.created"
    UPDATED = "task.updated"
    COMPLETED = "task.completed"
    FAILED = "task.failed"
    CANCELED = "task.canceled"


class TaskRecord(BaseModel):
    task_id: str
    conversation_id: str
    goal: str
    context: Optional[str] = None
    priority: TaskPriority = "normal"
    status: TaskStatus = TaskStatus.QUEUED
    external_task_id: Optional[str] = None
    result: Optional[Any] = None
    error: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)
    updates: List[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    completed_at: Optional[datetime] = None


class TaskEvent(BaseModel):
    type: TaskEventKind
    conversation_id: str
    task: TaskRecord
    timestamp: datetime = Field(default_factory=utcnow)


class CreateTaskInput(BaseModel):
    goal: str = Field(min_length=1)
    context: Optional[str] = None
    priority: TaskPriority = "normal"
    metadata: Dict[str, Any] = Field(default_factory=dict)


class ListTasksInput(BaseModel):
    status: Optional[TaskStatus] = None
    limit: int = Field(default=20, ge=1, le=100)


class CheckTaskStatusInput(BaseModel):
    task_id: str = Field(min_length=1)


class UpdateTaskInput(BaseModel):
    task_id: str = Field(min_length=1)
    instruction: str = Field(min_length=1)


class CancelTaskInput(BaseModel):
    task_id: str = Field(min_length=1)


class TaskResponse(BaseModel):
    task: TaskRecord


class TaskListResponse(BaseModel):
    tasks: List[TaskRecord]


class TaskEventResponse(BaseModel):
    type: Literal["agent_task.update"] = "agent_task.update"
    payload: TaskEvent


class ExternalTaskState(BaseModel):
    """Normalized external task state returned by an Agent Zero executor."""

    external_task_id: str
    status: TaskStatus
    result: Optional[Any] = None
    error: Optional[str] = None
    raw: Dict[str, Any] = Field(default_factory=dict)
