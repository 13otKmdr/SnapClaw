# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SnapClaw is a voice-first AI assistant (v2.1.0) that proxies between a React Native mobile app, OpenAI's Realtime API (or Z.AI GLM-5), and Agent Zero for asynchronous task execution. The system enables push-to-talk voice interactions where users can issue commands that are executed by an Agent Zero AI backend.

## Repository Structure

```
SnapClaw/
├── backend/                    # FastAPI backend (Python 3.11)
│   ├── main.py                 # App entry point: routes, auth, WebSocket handler (512 lines)
│   ├── auth.py                 # JWT auth, bcrypt hashing, user management, API keys
│   ├── config.py               # Settings singleton loaded from .env
│   ├── requirements.txt        # Backend-specific Python dependencies
│   ├── Dockerfile              # Backend container image
│   ├── orchestration/          # Task lifecycle & realtime proxy
│   │   ├── realtime_proxy.py   # Bidirectional WS bridge to OpenAI/Z.AI
│   │   ├── task_manager.py     # Task CRUD + lifecycle (QUEUED→RUNNING→SUCCEEDED/FAILED)
│   │   ├── task_store.py       # InMemory & Redis persistence backends
│   │   ├── agent_zero_executor.py  # HTTP executor (real) + MockExecutor (dev)
│   │   ├── models.py           # Pydantic models: TaskRecord, TaskStatus, TaskEvent
│   │   ├── tools.py            # GPT-4o function specs + OrchestrationToolRouter
│   │   ├── routes.py           # HTTP REST endpoints for task CRUD
│   │   └── dependencies.py     # Singleton DI: get_task_manager(), get_tool_router()
│   ├── voice/
│   │   ├── stt.py              # STT: Whisper API or Z.AI ASR
│   │   └── tts.py              # TTS: OpenAI or Piper
│   ├── memory/
│   │   ├── session.py          # SQLite chat/message store (aiosqlite)
│   │   └── compressor.py       # Conversation summarization
│   ├── adapters/
│   │   ├── base.py             # Abstract adapter interface
│   │   └── agent_zero.py       # HTTP client wrapper for Agent Zero
│   └── integrations/
│       └── agent_zero.py       # High-level Agent Zero task client
├── mobile/                     # React Native / Expo app
│   ├── App.tsx                 # Root: SafeAreaProvider, Stack Navigator, VoiceProvider
│   ├── app.json                # Expo config (iOS bundle, Android perms, plugins)
│   ├── eas.json                # EAS build profiles
│   ├── tsconfig.json           # TypeScript config
│   ├── package.json            # Expo 54, React 19, React Native 0.81
│   └── src/
│       ├── components/         # VoiceButton, MessageBubble, StreamingMessage, modals
│       ├── hooks/              # useVoice (context), useChats
│       ├── screens/            # HomeScreen, SettingsScreen, LoginScreen
│       └── services/           # api.ts, websocket.ts, authService.ts
├── deploy/
│   ├── caddy/Caddyfile         # Reverse proxy with automatic SSL
│   └── deploy-to-vps.sh        # Automated VPS deployment via rsync + Docker Compose
├── docs/
│   └── TESTFLIGHT_DEPLOYMENT.md
├── Dockerfile.backend          # Root-level backend image (Python 3.11-slim)
├── docker-compose.yml          # Services: caddy, backend, redis
├── requirements.txt            # Root requirements (mirrors backend/)
├── .env.example                # Environment variable template
└── TECHNICAL_SPECIFICATION.md  # Detailed architecture & implementation spec
```

## Commands

### Backend (FastAPI)

```bash
# First-time setup
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env           # Then edit .env with your keys

# Run dev server (from repo root)
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

### Mobile (React Native / Expo)

```bash
cd mobile
npm install
npm start        # Expo dev server (Metro bundler)
npm run ios      # iOS simulator
npm run android  # Android emulator
```

Mobile environment variables go in `mobile/.env` or via Expo config:

```bash
EXPO_PUBLIC_API_URL=http://localhost:8000
EXPO_PUBLIC_WS_URL=ws://localhost:8000
```

### Docker (full stack)

```bash
docker-compose up         # Start caddy + backend + redis
docker-compose up -d      # Detached mode
docker-compose down       # Stop all services
docker-compose logs -f backend  # Tail backend logs
```

### Tests

> **Note:** The test suite referenced below is not yet implemented. The `tests/` directories (`unit/`, `integration/`, `adversarial/`, `performance/`) do not currently exist and must be created before running these commands.

```bash
pytest tests/unit/
pytest tests/integration/
pytest tests/adversarial/
pytest tests/performance/ --benchmark-only
```

## Architecture

```
Mobile App (React Native/Expo)
  └─ VoiceProvider context (useVoice hook)
       ├─ WebSocket → /ws/realtime/{conversation_id}   [voice streaming + task events]
       └─ REST API  → /api/voice/process               [fallback text processing]

FastAPI Backend (backend/)
  ├─ main.py             – routes, CORS, auth, WebSocket handler
  ├─ orchestration/      – task lifecycle & realtime proxy
  │   ├─ realtime_proxy.py      – bidirectional WS bridge to OpenAI/Z.AI Realtime API
  │   ├─ task_manager.py        – QUEUED→RUNNING→SUCCEEDED/FAILED lifecycle + event fanout
  │   ├─ agent_zero_executor.py – HTTP calls to Agent Zero (or MockExecutor for dev)
  │   ├─ task_store.py          – InMemory (dev) or Redis (prod) persistence
  │   ├─ tools.py               – GPT-4o function schema + OrchestrationToolRouter
  │   ├─ routes.py              – HTTP REST endpoints: /api/tasks CRUD
  │   └─ dependencies.py        – get_task_manager(), get_tool_router() singletons
  ├─ voice/              – STT (Whisper/Z.AI) and TTS (OpenAI/Piper)
  ├─ memory/             – SQLite session state + conversation compressor
  ├─ adapters/           – Agent Zero HTTP client
  └─ integrations/       – Agent Zero high-level client

External Services:
  Agent Zero  (AGENT_ZERO_URL, default: http://localhost:50001)
  OpenAI Realtime API (wss://api.openai.com/v1/realtime)
  Z.AI GLM-5  (alternative realtime provider)
```

### Data Flow

1. Mobile sends audio/text over WebSocket to `/ws/realtime/{conversation_id}`
2. Backend (`realtime_proxy.py`) proxies the connection to OpenAI Realtime API, injecting Agent Zero tool specs into the session
3. GPT-4o responds conversationally and may call tools (`create_task`, `list_tasks`, `check_task_status`, `update_task`, `cancel_task`)
4. `OrchestrationToolRouter` intercepts function calls and dispatches them to `TaskManager`
5. `TaskManager` delegates to `AgentZeroExecutor` (HTTP POST to Agent Zero or mock simulation)
6. Task status updates are polled every `TASK_POLL_INTERVAL_SECONDS` (default: 2s) and pushed back to the mobile client as `agent_task.update` WebSocket events

### Task Lifecycle

```
QUEUED → RUNNING → WAITING_INPUT → SUCCEEDED
                               └→ FAILED
                               └→ CANCELED
```

Task status is normalized from Agent Zero's external states:

| Agent Zero State | Internal Status |
|-----------------|----------------|
| pending          | QUEUED         |
| running          | RUNNING        |
| waiting_input    | WAITING_INPUT  |
| completed        | SUCCEEDED      |
| failed           | FAILED         |
| cancelled        | CANCELED       |

### Auth

- `POST /api/auth/register` and `POST /api/auth/login` return JWT bearer tokens (HS256, 7-day expiry)
- `POST /api/auth/api-keys` generates API keys with `vi_` prefix (stored in-memory or DB)
- `GET /api/auth/me` returns current user info
- Mobile stores tokens in Expo SecureStore via `authService.ts`
- All protected routes require `Authorization: Bearer <token>` header

## API Endpoints

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Register user, returns JWT |
| POST | `/api/auth/login` | Login, returns JWT |
| POST | `/api/auth/api-keys` | Generate API key (vi_ prefix) |
| GET | `/api/auth/me` | Current user info |

### Voice

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/voice/process` | Process audio/text, returns VoiceResponse |
| POST | `/api/voice/transcribe` | Transcribe audio (Whisper), returns text |
| POST | `/api/voice/confirm` | Confirm pending action |

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/tasks` | Create task |
| GET | `/api/tasks` | List tasks (query: conversation_id, status, limit=20) |
| GET | `/api/tasks/{task_id}` | Get single task |
| POST | `/api/tasks/{task_id}/update` | Send instruction to running task |
| POST | `/api/tasks/{task_id}/cancel` | Cancel task |

### Agent Zero

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/agent/execute` | Execute task directly |
| GET | `/api/agent/capabilities` | List Agent Zero capabilities |
| GET | `/api/agent/health` | Agent Zero health check |

### WebSocket

| Path | Description |
|------|-------------|
| `/ws/realtime/{conversation_id}` | Primary: OpenAI/Z.AI Realtime proxy |
| `/ws/{session_id}` | Legacy session WebSocket |

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | `{"status": "healthy", "timestamp": "..."}` |
| GET | `/` | API info |

## WebSocket Protocol

### Client → Backend (Mobile sends to `/ws/realtime/{conversation_id}`)

Standard OpenAI Realtime API event format. Key events:

```json
{"type": "input_audio_buffer.append", "audio": "<base64>"}
{"type": "input_audio_buffer.commit"}
{"type": "conversation.item.create", "item": {"role": "user", "content": [...]}}
{"type": "response.create"}
```

### Backend → Client (Server pushes to mobile)

Standard OpenAI Realtime events are forwarded, plus SnapClaw-specific events:

```json
// Assistant text streaming
{"type": "response", "text": "...", "done": false}
{"type": "response_done"}

// Agent Zero task updates
{"type": "agent_task.update", "task": {"task_id": "...", "status": "running", "goal": "...", "result": null}}

// Errors
{"type": "error", "message": "...", "code": "..."}
```

## GPT-4o Realtime Tools

The realtime proxy injects these tools into the OpenAI session. GPT-4o may call them during conversation:

| Tool | Description |
|------|-------------|
| `create_task` | Create an async Agent Zero task with goal, context, priority |
| `list_tasks` | Query tasks by conversation_id and/or status |
| `check_task_status` | Poll a specific task's current status and result |
| `update_task` | Send an instruction to a running task (WAITING_INPUT state) |
| `cancel_task` | Cancel a queued or running task |

## Key Configuration (`.env`)

```bash
# --- Required ---
OPENAI_API_KEY=sk-...
OPENAI_REALTIME_MODEL=gpt-4o-realtime-preview
JWT_SECRET_KEY=change-me              # CRITICAL: use 32+ random chars in production

# --- Agent Zero ---
AGENT_ZERO_URL=http://localhost:50001
AGENT_ZERO_EXECUTOR=mock              # "http" (real Agent Zero) or "mock" (local simulation)
AGENT_ZERO_TIMEOUT=30                 # Request timeout in seconds

# --- Realtime Provider ---
REALTIME_PROVIDER=                    # "openai" or "zai"; auto-detected if blank
REALTIME_ENABLE_SERVER_VAD=true       # Server-side voice activity detection
OPENAI_REALTIME_VOICE=alloy           # TTS voice for realtime responses

# --- Z.AI (alternative to OpenAI Realtime) ---
ZAI_API_KEY=
ZAI_MODEL=glm-5
ZAI_BASE_URL=

# --- Task Store ---
TASK_STORE=memory                     # "memory" (default) or "redis"
REDIS_URL=redis://redis:6379/0
TASK_POLL_INTERVAL_SECONDS=2          # Background polling rate for task status

# --- Integrations ---
TELEGRAM_BOT_TOKEN=                   # Optional: Telegram bot integration

# --- Mobile client env (in mobile/.env or via Expo) ---
EXPO_PUBLIC_API_URL=http://localhost:8000
EXPO_PUBLIC_WS_URL=ws://localhost:8000

# --- Production (VPS deployment) ---
DOMAIN=your-domain.com
EMAIL=your@email.com                  # For Let's Encrypt SSL
```

## Data Models

### TaskRecord (backend/orchestration/models.py)

```python
{
  "task_id": "task_<uuid>",
  "conversation_id": "<uuid>",
  "goal": "Research the topic and summarize findings",
  "context": {"key": "value"},          # Optional additional context
  "priority": "normal",                 # "low" | "normal" | "high"
  "status": "queued",                   # See TaskStatus enum
  "external_task_id": "<agent_zero_id>",
  "result": null,                       # Populated when SUCCEEDED
  "error": null,                        # Populated when FAILED
  "updates": [],                        # List of progress updates
  "created_at": "2025-02-25T00:00:00Z",
  "updated_at": "2025-02-25T00:00:00Z",
  "completed_at": null
}
```

### Chat / Message (backend/memory/session.py — SQLite)

```python
# Chat
{"id": "chat_<uuid>", "name": "...", "summary": "...", "created_at": "..."}

# Message
{"id": "msg_<uuid>", "chat_id": "...", "role": "user|assistant|system", "text": "...", "created_at": "..."}
```

## Key Conventions

### Provider Abstraction Pattern

Backend uses abstract interfaces with swappable implementations:

- `AgentZeroExecutor` (abstract) → `HttpAgentZeroExecutor` (prod) / `MockAgentZeroExecutor` (dev)
- `TaskStore` (abstract) → `InMemoryTaskStore` (dev) / `RedisTaskStore` (prod)

### Singleton Dependency Injection

`backend/orchestration/dependencies.py` provides `get_task_manager()` and `get_tool_router()` as module-level singletons. Always use these functions rather than instantiating directly.

### React Context for Mobile State

All voice/WebSocket state is managed in `VoiceProvider` (`src/hooks/useVoice.tsx`). Components access it via `useVoice()` hook. Do not manage WebSocket connections outside this context.

### API Client on Mobile

`src/services/api.ts` (`ApiService`) handles all REST calls with automatic JWT injection from `AuthService`. `src/services/websocket.ts` (`WebSocketService`) is a singleton for the realtime WebSocket connection.

### Task Priority Values

Use lowercase strings: `"low"`, `"normal"`, `"high"`. Default is `"normal"`.

## Development Modes

### Frontend Dev Without Agent Zero (Mock Mode)

Set `AGENT_ZERO_EXECUTOR=mock` in `.env`. Tasks auto-complete in-memory after a configurable delay. No real Agent Zero instance required.

### Switching Realtime Providers

- `REALTIME_PROVIDER=openai` — Uses OpenAI Realtime API (`wss://api.openai.com/v1/realtime`)
- `REALTIME_PROVIDER=zai` — Uses Z.AI GLM-5 (requires `ZAI_API_KEY` and `ZAI_BASE_URL`)
- Leave blank for auto-detection (defaults to `openai` if `OPENAI_API_KEY` is set)

### In-Memory vs Redis Task Store

- Development: `TASK_STORE=memory` — volatile, no Redis required
- Production: `TASK_STORE=redis` — requires `REDIS_URL`, tasks survive backend restarts

## Deployment

### VPS (Docker Compose + Caddy)

```bash
# Deploy to remote VPS
./deploy/deploy-to-vps.sh

# Stack: Caddy (SSL/proxy) + FastAPI backend + Redis
# Caddy handles Let's Encrypt SSL automatically via DOMAIN and EMAIL env vars
```

Services defined in `docker-compose.yml`:
- `caddy`: Reverse proxy (ports 80/443) — config in `deploy/caddy/Caddyfile`
- `backend`: FastAPI app (internal port 8000)
- `redis`: Task store (internal port 6379)

### iOS (TestFlight)

See `docs/TESTFLIGHT_DEPLOYMENT.md` for EAS build and TestFlight submission steps.

## Production Security Checklist

Before deploying to production:

- [ ] Set `JWT_SECRET_KEY` to a random 32+ character string (never use `change-me`)
- [ ] Restrict CORS: change `allow_origins=["*"]` in `backend/main.py` to your actual domain
- [ ] Set `AGENT_ZERO_EXECUTOR=http` (never `mock` in production)
- [ ] Set `TASK_STORE=redis` and configure a password-protected Redis instance
- [ ] Set `DOMAIN` and `EMAIL` env vars for Caddy/Let's Encrypt
- [ ] Rotate all API keys (`OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, etc.)
- [ ] Verify Agent Zero instance is secured and not publicly accessible

## Troubleshooting

### Backend won't start

- Ensure venv is activated: `source venv/bin/activate`
- Check `.env` exists and has required vars (`OPENAI_API_KEY`, `JWT_SECRET_KEY`)
- Port 8000 must be free: `lsof -i :8000`

### WebSocket connection fails on mobile

- Confirm `EXPO_PUBLIC_WS_URL` points to running backend
- For iOS simulator, use `ws://localhost:8000` (not `127.0.0.1`)
- For physical devices, use the machine's LAN IP (e.g., `ws://192.168.1.x:8000`)

### Task stays in QUEUED state forever

- In mock mode, check `AGENT_ZERO_EXECUTOR=mock` is set
- In http mode, verify Agent Zero is reachable at `AGENT_ZERO_URL`
- Check `TASK_POLL_INTERVAL_SECONDS` is set (default 2s)

### Audio recording fails on mobile

- iOS requires microphone permission in `app.json` (already configured)
- Android requires `RECORD_AUDIO` permission (already configured)
- Expo Go may not support all audio features — use a development build

### `.claude/launch.json` Python path errors

The `.claude/launch.json` Python executable path is worktree-specific. If you create a new venv or git worktree, update the path to match the new `venv/bin/python` location.

## Notes

- CORS is currently fully open (`allow_origins=["*"]`) — **restrict for production**
- The `realtime_proxy.py` handles two realtime providers: `openai` and `zai` (Z.AI GLM-5), selected via `REALTIME_PROVIDER` env var
- In mock executor mode (`AGENT_ZERO_EXECUTOR=mock`), tasks auto-complete in memory after a configurable delay — useful for frontend development without a real Agent Zero instance
- Memory session storage (`memory/session.py`) uses SQLite via `aiosqlite` — the DB path is configured in `config.py`
- The `backend/integrations/` directory contains higher-level wrappers over `backend/adapters/` — prefer `integrations/agent_zero.py` over `adapters/agent_zero.py` for new feature work
- `backend/main.py` supports OpenRouter and Z.AI as LLM providers in addition to direct OpenAI calls — configured via env vars
