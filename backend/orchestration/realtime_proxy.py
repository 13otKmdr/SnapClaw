"""Realtime API proxy that equips a realtime model with Agent Zero task orchestration tools."""
from __future__ import annotations

import asyncio
import inspect
import json
import os
from typing import Any, Dict, Optional, Set, Tuple
from urllib.parse import urlencode

import websockets
from fastapi import WebSocket, WebSocketDisconnect

from .dependencies import get_task_manager, get_tool_router
from .models import TaskEventResponse
from .tools import build_realtime_tool_specs


DEFAULT_ASSISTANT_INSTRUCTIONS = (
    "You are a voice-first orchestration assistant with your own personality and memory. "
    "Hold a natural conversation while delegating execution work to Agent Zero using tools. "
    "When users ask to run work, create tasks with clear goals, then monitor progress using "
    "list_tasks/check_task_status and narrate updates. If users change direction, call update_task. "
    "If users stop work, call cancel_task."
)


def _resolve_provider_and_key() -> Tuple[str, str]:
    provider = os.environ.get("REALTIME_PROVIDER", "").strip().lower()
    openai_key = os.environ.get("OPENAI_API_KEY", "").strip()
    zai_key = os.environ.get("ZAI_API_KEY", "").strip()

    if provider in {"zai", "z.ai", "glm", "bigmodel"}:
        return "zai", zai_key
    if provider == "openai":
        return "openai", openai_key

    if openai_key:
        return "openai", openai_key
    if zai_key:
        return "zai", zai_key

    return "", ""


def _build_realtime_ws_url(provider: str) -> str:
    if provider == "zai":
        base = os.environ.get("ZAI_REALTIME_URL", "wss://open.bigmodel.cn/api/paas/v4/realtime")
        model = os.environ.get("ZAI_REALTIME_MODEL", "glm-realtime")
    else:
        base = os.environ.get("OPENAI_REALTIME_URL", "wss://api.openai.com/v1/realtime")
        model = os.environ.get("OPENAI_REALTIME_MODEL", "gpt-realtime")

    query = urlencode({"model": model})
    return f"{base}?{query}"


def _build_session_update(conversation_id: str, provider: str) -> Dict[str, Any]:
    instructions = os.environ.get("REALTIME_ASSISTANT_INSTRUCTIONS", DEFAULT_ASSISTANT_INSTRUCTIONS)
    instructions = f"Conversation ID: {conversation_id}\n{instructions}"

    model = (
        os.environ.get("ZAI_REALTIME_MODEL", "glm-realtime")
        if provider == "zai"
        else os.environ.get("OPENAI_REALTIME_MODEL", "gpt-realtime")
    )

    session: Dict[str, Any] = {
        "model": model,
        "instructions": instructions,
        "tools": build_realtime_tool_specs(),
        "tool_choice": "auto",
    }

    voice = (
        os.environ.get("ZAI_REALTIME_VOICE")
        if provider == "zai"
        else os.environ.get("OPENAI_REALTIME_VOICE")
    )
    if voice:
        session["voice"] = voice

    if os.environ.get("REALTIME_ENABLE_SERVER_VAD", "true").lower() in {"1", "true", "yes"}:
        session["turn_detection"] = {"type": "server_vad"}

    return {"type": "session.update", "session": session}


def _extract_function_call(event: Dict[str, Any]) -> Optional[Tuple[str, str, Any]]:
    event_type = event.get("type")

    if event_type == "response.output_item.done":
        item = event.get("item") or {}
        if item.get("type") == "function_call":
            return (
                item.get("call_id") or item.get("id") or "",
                item.get("name") or "",
                item.get("arguments"),
            )

    if event_type == "response.function_call_arguments.done":
        return (
            event.get("call_id") or "",
            event.get("name") or "",
            event.get("arguments"),
        )

    if event_type == "conversation.item.created":
        item = event.get("item") or {}
        if item.get("type") == "function_call":
            return (
                item.get("call_id") or item.get("id") or "",
                item.get("name") or "",
                item.get("arguments"),
            )

    return None


async def handle_realtime_proxy(websocket: WebSocket, conversation_id: str) -> None:
    """Bridge client WebSocket <-> upstream realtime provider and execute tool calls."""

    await websocket.accept()

    provider, api_key = _resolve_provider_and_key()
    if not api_key:
        await websocket.send_json(
            {
                "type": "proxy.error",
                "error": "No realtime API key configured. Set ZAI_API_KEY or OPENAI_API_KEY.",
            }
        )
        await websocket.close(code=1011)
        return

    task_manager = get_task_manager()
    tool_router = get_tool_router()
    await task_manager.initialize()

    upstream_url = _build_realtime_ws_url(provider)
    upstream_headers = {"Authorization": f"Bearer {api_key}"}

    task_event_queue = await task_manager.subscribe(conversation_id)

    try:
        connect_kwargs: Dict[str, Any] = {
            "ping_interval": 20,
            "ping_timeout": 20,
            "max_size": 8 * 1024 * 1024,
        }
        # websockets<=15 uses extra_headers; websockets>=16 uses additional_headers.
        param_names = set(inspect.signature(websockets.connect).parameters.keys())
        if "additional_headers" in param_names:
            connect_kwargs["additional_headers"] = upstream_headers
        else:
            connect_kwargs["extra_headers"] = upstream_headers

        async with websockets.connect(upstream_url, **connect_kwargs) as upstream:
            await upstream.send(json.dumps(_build_session_update(conversation_id, provider)))

            completed_tool_calls: Set[str] = set()

            tasks = [
                asyncio.create_task(_client_to_upstream(websocket, upstream)),
                asyncio.create_task(
                    _upstream_to_client(
                        websocket,
                        upstream,
                        tool_router,
                        conversation_id,
                        completed_tool_calls,
                    )
                ),
                asyncio.create_task(_task_events_to_client(websocket, task_event_queue)),
            ]

            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)

            for task in pending:
                task.cancel()

            if pending:
                await asyncio.gather(*pending, return_exceptions=True)

            for task in done:
                if task.cancelled():
                    continue
                exc = task.exception()
                if exc and not isinstance(exc, WebSocketDisconnect):
                    raise exc

    except WebSocketDisconnect:
        return
    except Exception as exc:
        await _safe_send_json(websocket, {"type": "proxy.error", "error": str(exc)})
    finally:
        await task_manager.unsubscribe(conversation_id, task_event_queue)
        if websocket.client_state.name != "DISCONNECTED":
            try:
                await websocket.close()
            except RuntimeError:
                pass


async def _client_to_upstream(websocket: WebSocket, upstream: Any) -> None:
    while True:
        message = await websocket.receive()
        message_type = message.get("type")

        if message_type == "websocket.disconnect":
            return

        text = message.get("text")
        if text is not None:
            await upstream.send(text)
            continue

        data = message.get("bytes")
        if data is not None:
            await upstream.send(data.decode("utf-8"))


async def _upstream_to_client(
    websocket: WebSocket,
    upstream: Any,
    tool_router: Any,
    conversation_id: str,
    completed_tool_calls: Set[str],
) -> None:
    call_name_cache: Dict[str, str] = {}
    call_arg_fragments: Dict[str, str] = {}

    while True:
        raw = await upstream.recv()

        if isinstance(raw, bytes):
            raw_text = raw.decode("utf-8")
        else:
            raw_text = raw

        await websocket.send_text(raw_text)

        try:
            event = json.loads(raw_text)
        except json.JSONDecodeError:
            continue

        event_type = event.get("type")
        if event_type in {"response.output_item.added", "response.output_item.done", "conversation.item.created"}:
            item = event.get("item") or {}
            if item.get("type") == "function_call":
                call_id = item.get("call_id")
                if call_id and item.get("name"):
                    call_name_cache[call_id] = item["name"]

        if event_type == "response.function_call_arguments.delta":
            call_id = event.get("call_id")
            delta = event.get("delta")
            if call_id and isinstance(delta, str):
                call_arg_fragments[call_id] = f"{call_arg_fragments.get(call_id, '')}{delta}"
            continue

        if event_type == "response.function_call_arguments.done":
            call_id = event.get("call_id")
            if call_id and not event.get("name"):
                event["name"] = call_name_cache.get(call_id, "")
            if call_id and not event.get("arguments"):
                event["arguments"] = call_arg_fragments.pop(call_id, "")

        tool_call = _extract_function_call(event)
        if not tool_call:
            continue

        call_id, tool_name, arguments = tool_call
        if not call_id or not tool_name:
            continue

        if call_id in completed_tool_calls:
            continue

        completed_tool_calls.add(call_id)
        tool_result = await tool_router.handle_tool_call(
            name=tool_name,
            arguments=arguments,
            conversation_id=conversation_id,
        )

        output_event = {
            "type": "conversation.item.create",
            "item": {
                "type": "function_call_output",
                "call_id": call_id,
                "output": json.dumps(tool_result),
            },
        }

        await upstream.send(json.dumps(output_event))
        await upstream.send(json.dumps({"type": "response.create"}))

        await _safe_send_json(
            websocket,
            {
                "type": "agent_tool.result",
                "call_id": call_id,
                "name": tool_name,
                "output": tool_result,
            },
        )


async def _task_events_to_client(websocket: WebSocket, queue: asyncio.Queue) -> None:
    while True:
        event = await queue.get()
        payload = TaskEventResponse(payload=event)
        await _safe_send_json(websocket, payload.model_dump(mode="json"))


async def _safe_send_json(websocket: WebSocket, payload: Dict[str, Any]) -> None:
    try:
        await websocket.send_json(payload)
    except (RuntimeError, WebSocketDisconnect):
        return
