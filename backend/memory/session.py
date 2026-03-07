"""
SQLite-backed session store.
One SQLite file lives next to the backend — no external DB needed.

Schema
------
chats    (id, name, agent_context_id, summary, created_at, updated_at)
messages (id, chat_id, role, text, created_at)
"""
import uuid
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import aiosqlite

from ..config import settings

log = logging.getLogger(__name__)

DB_PATH = settings.db_path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS chats (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    agent_context_id TEXT,
    summary          TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,   -- 'user' | 'assistant' | 'system'
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- Optimization: Add indexes to prevent full table scans on queries with ORDER BY
-- SQLite does not create indexes for foreign keys automatically.
CREATE INDEX IF NOT EXISTS idx_chats_updated_at ON chats(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_chat_id_created_at ON messages(chat_id, created_at);
"""


@dataclass
class Message:
    id: str
    chat_id: str
    role: str
    text: str
    created_at: datetime


@dataclass
class Chat:
    id: str
    name: str
    agent_context_id: Optional[str]
    summary: Optional[str]
    created_at: datetime
    updated_at: datetime
    messages: list[Message] = field(default_factory=list)


class SessionStore:
    _initialized: bool = False

    async def _db(self):
        """Return an aiosqlite context manager. Use as: async with self._db() as db:"""
        return aiosqlite.connect(DB_PATH)

    async def _ensure_schema(self, db: aiosqlite.Connection):
        if not SessionStore._initialized:
            db.row_factory = aiosqlite.Row
            await db.executescript(_SCHEMA)
            await db.commit()
            SessionStore._initialized = True
        else:
            db.row_factory = aiosqlite.Row

    # ------------------------------------------------------------------
    # Chats
    # ------------------------------------------------------------------

    async def create_chat(self, name: str) -> Chat:
        now = _now()
        chat = Chat(
            id=str(uuid.uuid4()),
            name=name,
            agent_context_id=None,
            summary=None,
            created_at=now,
            updated_at=now,
        )
        async with aiosqlite.connect(DB_PATH) as db:
            await self._ensure_schema(db)
            await db.execute(
                "INSERT INTO chats VALUES (?,?,?,?,?,?)",
                (chat.id, chat.name, chat.agent_context_id,
                 chat.summary, _fmt(chat.created_at), _fmt(chat.updated_at)),
            )
            await db.commit()
        log.debug("Created chat %s (%s)", chat.id, chat.name)
        return chat

    async def list_chats(self) -> list[Chat]:
        async with aiosqlite.connect(DB_PATH) as db:
            await self._ensure_schema(db)
            rows = await db.execute_fetchall(
                "SELECT * FROM chats ORDER BY updated_at DESC"
            )
        return [_row_to_chat(r) for r in rows]

    async def get_chat(self, chat_id: str) -> Optional[Chat]:
        async with aiosqlite.connect(DB_PATH) as db:
            await self._ensure_schema(db)
            row = await (await db.execute(
                "SELECT * FROM chats WHERE id=?", (chat_id,)
            )).fetchone()
        return _row_to_chat(row) if row else None

    async def set_agent_context(self, chat_id: str, agent_context_id: str) -> None:
        async with aiosqlite.connect(DB_PATH) as db:
            await self._ensure_schema(db)
            await db.execute(
                "UPDATE chats SET agent_context_id=?, updated_at=? WHERE id=?",
                (agent_context_id, _fmt(_now()), chat_id),
            )
            await db.commit()

    async def update_summary(self, chat_id: str, summary: str) -> None:
        async with aiosqlite.connect(DB_PATH) as db:
            await self._ensure_schema(db)
            await db.execute(
                "UPDATE chats SET summary=?, updated_at=? WHERE id=?",
                (summary, _fmt(_now()), chat_id),
            )
            await db.commit()

    # ------------------------------------------------------------------
    # Messages
    # ------------------------------------------------------------------

    async def add_message(self, chat_id: str, role: str, text: str) -> Message:
        msg = Message(
            id=str(uuid.uuid4()),
            chat_id=chat_id,
            role=role,
            text=text,
            created_at=_now(),
        )
        async with aiosqlite.connect(DB_PATH) as db:
            await self._ensure_schema(db)
            await db.execute(
                "INSERT INTO messages VALUES (?,?,?,?,?)",
                (msg.id, msg.chat_id, msg.role, msg.text, _fmt(msg.created_at)),
            )
            # bump chat updated_at
            await db.execute(
                "UPDATE chats SET updated_at=? WHERE id=?",
                (_fmt(msg.created_at), chat_id),
            )
            await db.commit()
        return msg

    async def get_messages(self, chat_id: str) -> list[Message]:
        async with aiosqlite.connect(DB_PATH) as db:
            await self._ensure_schema(db)
            rows = await db.execute_fetchall(
                "SELECT * FROM messages WHERE chat_id=? ORDER BY created_at ASC",
                (chat_id,),
            )
        return [_row_to_message(r) for r in rows]

    async def message_count(self, chat_id: str) -> int:
        async with aiosqlite.connect(DB_PATH) as db:
            await self._ensure_schema(db)
            row = await (await db.execute(
                "SELECT COUNT(*) FROM messages WHERE chat_id=?", (chat_id,)
            )).fetchone()
        return row[0] if row else 0


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _fmt(dt: datetime) -> str:
    return dt.isoformat()


def _parse(s: str) -> datetime:
    return datetime.fromisoformat(s)


def _row_to_chat(row) -> Chat:
    return Chat(
        id=row["id"],
        name=row["name"],
        agent_context_id=row["agent_context_id"],
        summary=row["summary"],
        created_at=_parse(row["created_at"]),
        updated_at=_parse(row["updated_at"]),
    )


def _row_to_message(row) -> Message:
    return Message(
        id=row["id"],
        chat_id=row["chat_id"],
        role=row["role"],
        text=row["text"],
        created_at=_parse(row["created_at"]),
    )


# Module-level singleton
store = SessionStore()
