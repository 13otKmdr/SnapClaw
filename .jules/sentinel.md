## 2026-02-26 - Critical Auth Bypass in Orchestration
**Vulnerability:** Orchestration API routes (/api/tasks) were completely unauthenticated, allowing full control over Agent Zero tasks.
**Learning:** Router dependencies must be explicitly configured or inherited. Including a router in `main.py` via `app.include_router(orchestration_router)` does NOT automatically apply `app` level dependencies unless `dependencies` argument is used in `include_router`.
**Prevention:** Always verify authentication on new endpoints with integration tests that assert 401 for unauthenticated requests.
## 2026-02-28 - CRITICAL Hardcoded Secrets in Production Config
**Vulnerability:** Core application security variables `JWT_SECRET_KEY` and `APP_SECRET` fell back to known, insecure defaults ("your-super-secret-key-change-in-production" and "change-me") if environment variables were not set.
**Learning:** Security configurations must follow a "Fail Securely" principle. Defaulting to a weak secret allows the application to start in a vulnerable state without explicit warning, risking total authentication bypass.
**Prevention:** Critical secret keys should enforce their presence at application initialization by throwing a `RuntimeError` if missing, rather than defaulting to an insecure value.
## 2026-03-04 - Overly Permissive CORS Configuration
**Vulnerability:** The FastAPI backend used a wildcard `allow_origins=["*"]` in the `CORSMiddleware` configuration. This allowed any website to make cross-origin requests to the API, potentially leading to CSRF or unintended exposure of resources, violating the principle of least privilege.
**Learning:** Defaulting to a wildcard allows any origin to access the API. The CORS configuration must restrict allowed origins to trusted domains, ideally configured dynamically via an environment variable.
**Prevention:** Always restrict allowed CORS origins. In FastAPI, `allow_origins` must be a list of trusted origins (or use `allow_origin_regex` for controlled flexibility). Ensure the backend dynamically loads this list from its environment configuration (e.g. `settings.cors_origins`).
