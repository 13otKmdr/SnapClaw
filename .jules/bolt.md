
## 2025-02-28 - Fast O(1) email lookups
**Learning:** Found a major performance bug/bottleneck in auth where finding emails by user meant an O(N) sweep across the dictionary `api_keys_db` (which is wrong anyways).
**Action:** Adding a separate `users_email_db` dictionary index as O(1) mapper for user email lookups fixes functionality and boosts performance to blazing fast.
