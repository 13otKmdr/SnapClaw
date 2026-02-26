## 2026-02-26 - Critical Auth Bypass in Orchestration
**Vulnerability:** Orchestration API routes (/api/tasks) were completely unauthenticated, allowing full control over Agent Zero tasks.
**Learning:** Router dependencies must be explicitly configured or inherited. Including a router in `main.py` via `app.include_router(orchestration_router)` does NOT automatically apply `app` level dependencies unless `dependencies` argument is used in `include_router`.
**Prevention:** Always verify authentication on new endpoints with integration tests that assert 401 for unauthenticated requests.
