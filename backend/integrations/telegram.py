"""
Real Telegram Bot API Integration
"""
import os
from typing import Dict, Any, Optional, List
from datetime import datetime
import httpx
from pydantic import BaseModel

class TelegramMessage(BaseModel):
    message_id: int
    chat_id: int
    chat_type: str
    chat_title: Optional[str] = None
    from_user_id: Optional[int] = None
    from_username: Optional[str] = None
    text: Optional[str] = None
    date: datetime

class TelegramIntegration:
    """Real Telegram Bot API client."""
    
    BASE_URL = "https://api.telegram.org/bot{token}/{method}"
    
    def __init__(self, bot_token: Optional[str] = None):
        self.bot_token = bot_token or os.environ.get("TELEGRAM_BOT_TOKEN")
        self.client = httpx.AsyncClient(timeout=30.0)
        self._me_cache: Optional[Dict] = None
    
    async def _call_api(self, method: str, **params) -> Dict[str, Any]:
        """Make API call to Telegram."""
        if not self.bot_token:
            raise ValueError("Telegram bot token not configured")
        
        url = self.BASE_URL.format(token=self.bot_token, method=method)
        response = await self.client.post(url, json=params)
        response.raise_for_status()
        data = response.json()
        
        if not data.get("ok"):
            raise Exception(f"Telegram API error: {data.get('description')}")
        
        return data.get("result")
    
    async def get_me(self) -> Dict:
        """Get bot information."""
        if self._me_cache:
            return self._me_cache
        self._me_cache = await self._call_api("getMe")
        return self._me_cache
    
    async def get_updates(self, offset: int = 0, limit: int = 100) -> List[Dict]:
        """Get new updates (messages, etc.)."""
        return await self._call_api("getUpdates", offset=offset, limit=limit, timeout=30)
    
    async def send_message(self, chat_id: int, text: str, parse_mode: str = "Markdown") -> Dict:
        """Send a text message."""
        return await self._call_api("sendMessage", chat_id=chat_id, text=text, parse_mode=parse_mode)
    
    async def get_chat(self, chat_id: int) -> Dict:
        """Get chat information."""
        return await self._call_api("getChat", chat_id=chat_id)
    
    async def get_dialogs(self) -> List[Dict]:
        """Get list of chats/dialogs."""
        updates = await self.get_updates(limit=100)
        chats = {}
        for update in updates:
            if "message" in update:
                chat = update["message"]["chat"]
                chats[chat["id"]] = chat
            elif "my_chat_member" in update:
                chat = update["my_chat_member"]["chat"]
                chats[chat["id"]] = chat
        return list(chats.values())
    
    async def mark_read(self, chat_id: int, message_id: int) -> bool:
        """Mark messages as read."""
        result = await self._call_api("readMessage", chat_id=chat_id, message_id=message_id)
        return result == True
    
    async def close(self):
        """Close the HTTP client."""
        await self.client.aclose()

# Singleton
telegram_client: Optional[TelegramIntegration] = None

def get_telegram_client() -> TelegramIntegration:
    global telegram_client
    if telegram_client is None:
        telegram_client = TelegramIntegration()
    return telegram_client
