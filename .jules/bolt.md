
## 2025-02-28 - Fast O(1) email lookups
**Learning:** Found a major performance bug/bottleneck in auth where finding emails by user meant an O(N) sweep across the dictionary `api_keys_db` (which is wrong anyways).
**Action:** Adding a separate `users_email_db` dictionary index as O(1) mapper for user email lookups fixes functionality and boosts performance to blazing fast.

## 2025-02-28 - SQLite Foreign Key Performance Bottleneck
**Learning:** Discovered a major performance bottleneck where SQLite does not automatically create indexes for foreign keys or ORDER BY clauses. Queries like `SELECT * FROM messages WHERE chat_id=? ORDER BY created_at ASC` and `SELECT * FROM chats ORDER BY updated_at DESC` were performing full table scans (O(N)).
**Action:** Always manually define compound indexes `CREATE INDEX IF NOT EXISTS` for foreign keys and sorted columns (e.g., `(chat_id, created_at)`) in SQLite schemas to ensure fast O(log N) lookups.
