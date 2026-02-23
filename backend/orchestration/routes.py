"""HTTP routes for orchestration task lifecycle management."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .dependencies import get_task_manager
from .models import TaskListResponse, TaskPriority, TaskResponse, TaskStatus

router = APIRouter(prefix="/api/tasks", tags=["Task Orchestration"])


class CreateTaskRequest(BaseModel):
    conversation_id: str = Field(min_length=1)
    goal: str = Field(min_length=1)
    context: Optional[str] = None
    priority: TaskPriority = "normal"
    metadata: dict = Field(default_factory=dict)


class UpdateTaskRequest(BaseModel):
    instruction: str = Field(min_length=1)


@router.post("", response_model=TaskResponse)
async def create_task(request: CreateTaskRequest) -> TaskResponse:
    manager = get_task_manager()
    task = await manager.create_task(
        conversation_id=request.conversation_id,
        goal=request.goal,
        context=request.context,
        priority=request.priority,
        metadata=request.metadata,
    )
    return TaskResponse(task=task)


@router.get("", response_model=TaskListResponse)
async def list_tasks(
    conversation_id: str = Query(..., min_length=1),
    status: Optional[TaskStatus] = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
) -> TaskListResponse:
    manager = get_task_manager()
    tasks = await manager.list_tasks(conversation_id=conversation_id, status=status, limit=limit)
    return TaskListResponse(tasks=tasks)


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(task_id: str, refresh: bool = Query(default=True)) -> TaskResponse:
    manager = get_task_manager()
    task = await manager.refresh_task_status(task_id) if refresh else await manager.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return TaskResponse(task=task)


@router.post("/{task_id}/update", response_model=TaskResponse)
async def update_task(task_id: str, request: UpdateTaskRequest) -> TaskResponse:
    manager = get_task_manager()
    task = await manager.update_task(task_id, request.instruction)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return TaskResponse(task=task)


@router.post("/{task_id}/cancel", response_model=TaskResponse)
async def cancel_task(task_id: str) -> TaskResponse:
    manager = get_task_manager()
    task = await manager.cancel_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return TaskResponse(task=task)
