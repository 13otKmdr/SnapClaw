## 2026-02-26 - Critical Auth Bypass in Orchestration
**Vulnerability:** Orchestration API routes (/api/tasks) were completely unauthenticated, allowing full control over Agent Zero tasks.
**Learning:** Router dependencies must be explicitly configured or inherited. Including a router in `main.py` via `app.include_router(orchestration_router)` does NOT automatically apply `app` level dependencies unless `dependencies` argument is used in `include_router`.
**Prevention:** Always verify authentication on new endpoints with integration tests that assert 401 for unauthenticated requests.
## 2026-02-28 - CRITICAL Hardcoded Secrets in Production Config
**Vulnerability:** Core application security variables `JWT_SECRET_KEY` and `APP_SECRET` fell back to known, insecure defaults ("your-super-secret-key-change-in-production" and "change-me") if environment variables were not set.
**Learning:** Security configurations must follow a "Fail Securely" principle. Defaulting to a weak secret allows the application to start in a vulnerable state without explicit warning, risking total authentication bypass.
**Prevention:** Critical secret keys should enforce their presence at application initialization by throwing a `RuntimeError` if missing, rather than defaulting to an insecure value.
## 2026-03-03 - CRITICAL Overly Permissive CORS Configuration
**Vulnerability:** The application was configured with `allow_origins=["*"]` alongside `allow_credentials=True` in `CORSMiddleware`, which allows any website to make authenticated requests to the API.
**Learning:** Security configurations must enforce the principle of least privilege. Allowing all origins with credentials enabled is a severe security misconfiguration that can lead to Cross-Site Request Forgery (CSRF) and data leakage.
**Prevention:** Always restrict `allow_origins` to known, trusted domains, preferably using a centralized configuration setting (e.g., `settings.cors_origins`) that reads from environment variables.
