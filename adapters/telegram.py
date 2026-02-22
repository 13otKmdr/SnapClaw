"""
Telegram Adapter - HTTP client for Telegram Bot API
"""
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import datetime
from enum import Enum
import httpx
import asyncio


class TelegramAction(str, Enum):
    SEND_MESSAGE = "send_message"
    READ_MESSAGES = "read_messages"
    SEARCH_MESSAGES = "search_messages"
    SUMMARIZE_CHAT = "summarize_chat"
    REPLY_TO_THREAD = "reply_to_thread"


class TelegramTarget(BaseModel):
    chat_id: Optional[int] = None
    username: Optional[str] = None
    thread_id: Optional[int] = None


class TelegramMessage(BaseModel):
    message_id: int
    chat_id: int
    sender_id: int
    sender_name: str
    text: str
    timestamp: datetime
    is_reply_to: Optional[int] = None
    has_attachment: bool = False


class TelegramSendRequest(BaseModel):
    action: TelegramAction = TelegramAction.SEND_MESSAGE
    target: TelegramTarget
    text: str
    parse_mode: str = "Markdown"


class TelegramSendResponse(BaseModel):
    success: bool
    message_id: Optional[int] = None
    error: Optional[str] = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class TelegramReadRequest(BaseModel):
    action: TelegramAction = TelegramAction.READ_MESSAGES
    target: TelegramTarget
    limit: int = 20
    before_message_id: Optional[int] = None


class TelegramReadResponse(BaseModel):
    success: bool
    messages: List[TelegramMessage] = []
    has_more: bool = False
    error: Optional[str] = None


class TelegramAdapter:
    """Async HTTP client for Telegram Bot API."""

    def __init__(self, api_token: str, api_url: str = "https://api.telegram.org"):
        self.api_token = api_token
        self.base_url = f"{api_url}/bot{api_token}"
        self._client: Optional[httpx.AsyncClient] = None
        self._known_contacts: Dict[str, int] = {}  # name -> chat_id cache

    async def initialize(self):
        """Initialize HTTP client."""
        self._client = httpx.AsyncClient(timeout=30.0)

    async def close(self):
        """Close HTTP client."""
        if self._client:
            await self._client.aclose()

    async def _call(self, method: str, params: dict) -> dict:
        """Make API call to Telegram."""
        if not self._client:
            await self.initialize()

        url = f"{self.base_url}/{method}"
        response = await self._client.post(url, json=params)
        response.raise_for_status()
        return response.json()

    async def send_message(self, request: TelegramSendRequest) -> TelegramSendResponse:
        """Send a message to a Telegram chat."""
        try:
            chat_id = request.target.chat_id
            if not chat_id and request.target.username:
                chat_id = await self._resolve_username(request.target.username)

            params = {
                "chat_id": chat_id,
                "text": request.text,
                "parse_mode": request.parse_mode
            }

            if request.target.thread_id:
                params["message_thread_id"] = request.target.thread_id

            result = await self._call("sendMessage", params)

            return TelegramSendResponse(
                success=True,
                message_id=result["result"]["message_id"]
            )
        except Exception as e:
            return TelegramSendResponse(
                success=False,
                error=str(e)
            )

    async def read_messages(self, request: TelegramReadRequest) -> TelegramReadResponse:
        """Read messages from a Telegram chat."""
        try:
            params = {
                "chat_id": request.target.chat_id,
                "limit": request.limit
            }
            if request.before_message_id:
                params["before"] = request.before_message_id

            result = await self._call("getChatHistory", params)
            messages = [
                TelegramMessage(
                    message_id=msg["message_id"],
                    chat_id=msg["chat"]["id"],
                    sender_id=msg["from"]["id"],
                    sender_name=msg["from"].get("first_name", "Unknown"),
                    text=msg.get("text", ""),
                    timestamp=datetime.fromtimestamp(msg["date"]),
                    is_reply_to=msg.get("reply_to_message_id"),
                    has_attachment="document" in msg or "photo" in msg
                )
                for msg in result.get("result", [])
            ]

            return TelegramReadResponse(
                success=True,
                messages=messages,
                has_more=len(messages) == request.limit
            )
        except Exception as e:
            return TelegramReadResponse(
                success=False,
                error=str(e)
            )

    async def _resolve_username(self, username: str) -> int:
        """Resolve username to chat_id."""
        if username in self._known_contacts:
            return self._known_contacts[username]

        # Try to resolve via API
        result = await self._call("getChat", {"chat_id": f"@{username.lstrip('@')}"})
        chat_id = result["result"]["id"]
        self._known_contacts[username] = chat_id
        return chat_id

    def is_known_contact(self, name: str) -> bool:
        """Check if contact is in known contacts cache."""
        return name in self._known_contacts

    def add_known_contact(self, name: str, chat_id: int):
        """Add contact to known contacts cache."""
        self._known_contacts[name] = chat_id
