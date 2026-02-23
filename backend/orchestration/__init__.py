"""Realtime orchestration package for voice assistant task delegation."""

from .dependencies import get_task_manager, get_tool_router, shutdown_orchestration
from .realtime_proxy import handle_realtime_proxy

__all__ = ["get_task_manager", "get_tool_router", "shutdown_orchestration", "handle_realtime_proxy"]
