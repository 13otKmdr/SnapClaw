
## 2025-02-28 - Fast O(1) email lookups
**Learning:** Found a major performance bug/bottleneck in auth where finding emails by user meant an O(N) sweep across the dictionary `api_keys_db` (which is wrong anyways).
**Action:** Adding a separate `users_email_db` dictionary index as O(1) mapper for user email lookups fixes functionality and boosts performance to blazing fast.

## 2024-03-01 - SQLite Missing Indexes
**Learning:** SQLite schemas do not automatically define indexes for foreign keys (like `chat_id` in `messages`). This leads to full table scans and temporary B-trees for `ORDER BY` and `COUNT` queries on the messages and chats tables.
**Action:** Added explicit indexes to `backend/memory/session.py` for `chat_id`, `(chat_id, created_at)`, and `updated_at DESC` to make these lookups and sorts O(log N) instead of O(N).
