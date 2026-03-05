
## 2025-02-28 - Fast O(1) email lookups
**Learning:** Found a major performance bug/bottleneck in auth where finding emails by user meant an O(N) sweep across the dictionary `api_keys_db` (which is wrong anyways).
**Action:** Adding a separate `users_email_db` dictionary index as O(1) mapper for user email lookups fixes functionality and boosts performance to blazing fast.

## 2025-03-05 - Missing SQLite indexes
**Learning:** SQLite schemas defined in the codebase (e.g., `backend/memory/session.py`) lack indexes for foreign keys by default. This causes `O(N)` full table scans and temporary B-tree sorting operations (e.g., when retrieving chat history: `SELECT * FROM messages WHERE chat_id=? ORDER BY created_at ASC`).
**Action:** Always explicitly define required indexes, such as a compound index `CREATE INDEX IF NOT EXISTS idx_messages_chat_id_created_at ON messages(chat_id, created_at);`, to optimize retrieval and sorting.
