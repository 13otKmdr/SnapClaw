
## 2025-02-28 - Fast O(1) email lookups
**Learning:** Found a major performance bug/bottleneck in auth where finding emails by user meant an O(N) sweep across the dictionary `api_keys_db` (which is wrong anyways).
**Action:** Adding a separate `users_email_db` dictionary index as O(1) mapper for user email lookups fixes functionality and boosts performance to blazing fast.

## 2025-03-01 - Missing foreign key indexes in SQLite
**Learning:** Found an N+1/full-table-scan bottleneck in `backend/memory/session.py`. SQLite does not automatically index foreign keys (`messages.chat_id`). This meant every chat history fetch required an O(N) scan across *all* messages in the DB.
**Action:** Always explicitly define `CREATE INDEX` for foreign keys in SQLite schemas to ensure O(log N) retrieval. Added `idx_messages_chat_id` index to fix this.
