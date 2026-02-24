# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SnapClaw is a voice-first AI assistant that proxies between a React Native mobile app, OpenAI's Realtime API (or Z.AI), and Agent Zero for async task execution.

## Commands

### Backend (FastAPI)
```bash
# Setup venv and install dependencies
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Run dev server (from repo root)
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000

# Copy and configure environment
cp .env.example .env
```

### Mobile (React Native / Expo)
```bash
cd mobile
npm install
npm start        # Expo dev server
npm run ios      # iOS simulator
npm run android  # Android emulator
```

### Docker (full stack)
```bash
docker-compose up         # Start all services
docker-compose up -d      # Detached mode
docker-compose down       # Stop all services
```

### Tests
```bash
pytest tests/unit/
pytest tests/integration/
pytest tests/adversarial/
pytest tests/performance/ --benchmark-only
```

## Architecture

```
Mobile App (React Native/Expo)
  └─ useVoice hook (Context)
       ├─ WebSocket → /ws/realtime/{conversation_id}  [voice streaming + task events]
       └─ REST API  → /api/voice/process              [fallback text processing]

FastAPI Backend (backend/)
  ├─ main.py             – routes, auth, WebSocket handler
  ├─ orchestration/      – task lifecycle & realtime proxy
  │   ├─ realtime_proxy.py      – bidirectional WS bridge to OpenAI Realtime API
  │   ├─ task_manager.py        – QUEUED→RUNNING→SUCCEEDED/FAILED lifecycle
  │   ├─ agent_zero_executor.py – HTTP calls to Agent Zero (or mock for dev)
  │   ├─ task_store.py          – in-memory or Redis persistence
  │   └─ tools.py               – GPT-4o function schema (create/list/check/update/cancel task)
  ├─ voice/              – STT (Whisper) and TTS (Piper/OpenAI)
  ├─ memory/             – session state + conversation compressor
  └─ adapters/           – Agent Zero HTTP/WS client

Agent Zero  (external, AGENT_ZERO_URL)
OpenAI Realtime API (wss://api.openai.com/v1/realtime)
```

### Data Flow
1. Mobile sends audio/text over WebSocket to `/ws/realtime/{conversation_id}`
2. Backend (`realtime_proxy.py`) proxies the connection to OpenAI Realtime API
3. GPT-4o responds conversationally and may call tools (`create_task`, `cancel_task`, etc.)
4. Tool calls are intercepted by the proxy and dispatched to `TaskManager`
5. `TaskManager` delegates to `AgentZeroExecutor` (HTTP POST to Agent Zero)
6. Task status updates are polled and pushed back to the mobile client as `agent_task.update` WebSocket events

### Task Lifecycle
```
QUEUED → RUNNING → WAITING_INPUT → SUCCEEDED
                               └→ FAILED
                               └→ CANCELED
```

### Auth
- `POST /api/auth/register` and `/api/auth/login` return JWT bearer tokens
- API keys use `vi_` prefix, stored in-memory (or DB)
- Mobile stores tokens in Expo SecureStore

## Key Configuration (`.env`)

```bash
# Required
OPENAI_API_KEY=sk-...
OPENAI_REALTIME_MODEL=gpt-4o-realtime-preview
AGENT_ZERO_URL=http://localhost:50001
JWT_SECRET_KEY=change-me

# Executor mode: "http" (real Agent Zero) or "mock" (local simulation)
AGENT_ZERO_EXECUTOR=mock

# Task store: "memory" (default) or "redis"
TASK_STORE=memory

# Mobile client env (in mobile/.env or via Expo)
EXPO_PUBLIC_API_URL=http://localhost:8000
EXPO_PUBLIC_WS_URL=ws://localhost:8000
```

## Notes

- The `realtime_proxy.py` handles two realtime providers: `openai` and `zai` (Z.AI GLM-5), selected via `REALTIME_PROVIDER` env var
- In mock executor mode (`AGENT_ZERO_EXECUTOR=mock`), tasks auto-complete in memory after a configurable delay — useful for frontend development without a real Agent Zero instance
- CORS is currently open (`allow_origins=["*"]`) — restrict for production
- The `.claude/launch.json` path for the Python executable is worktree-specific and will need updating if you create a new venv
