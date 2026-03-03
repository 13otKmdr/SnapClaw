## 2026-02-26 - Critical Auth Bypass in Orchestration
**Vulnerability:** Orchestration API routes (/api/tasks) were completely unauthenticated, allowing full control over Agent Zero tasks.
**Learning:** Router dependencies must be explicitly configured or inherited. Including a router in `main.py` via `app.include_router(orchestration_router)` does NOT automatically apply `app` level dependencies unless `dependencies` argument is used in `include_router`.
**Prevention:** Always verify authentication on new endpoints with integration tests that assert 401 for unauthenticated requests.
## 2026-02-28 - CRITICAL Hardcoded Secrets in Production Config
**Vulnerability:** Core application security variables `JWT_SECRET_KEY` and `APP_SECRET` fell back to known, insecure defaults ("your-super-secret-key-change-in-production" and "change-me") if environment variables were not set.
**Learning:** Security configurations must follow a "Fail Securely" principle. Defaulting to a weak secret allows the application to start in a vulnerable state without explicit warning, risking total authentication bypass.
**Prevention:** Critical secret keys should enforce their presence at application initialization by throwing a `RuntimeError` if missing, rather than defaulting to an insecure value.
## 2025-03-02 - Restrict overly permissive CORS configuration
**Vulnerability:** The FastAPI backend used `allow_origins=["*"]` along with `allow_credentials=True` in `CORSMiddleware`, which is overly permissive and insecure.
**Learning:** This could allow any malicious website to make cross-origin requests to the API on behalf of an authenticated user.
**Prevention:** Always restrict `allow_origins` to a specific list of trusted domains. Use environment variables (e.g. `ALLOWED_ORIGINS`) to configure this securely per environment.
