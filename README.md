# SnapClaw

## Positioning Statement

SnapClaw is a voice-first orchestration layer that sits above OpenClaw / Agent Zero / model providers so users stay in fluid conversation while background tasks run.

## Product Spec Header (North Star)

- tap once to open live voice session
- fluid back-and-forth turn-taking
- background task orchestration + steering
- parallel tasks + progress narration
- safe confirmations for high-impact actions

A hands-free, real-time voice interface with command capabilities for Telegram, Agent Zero, and OpenClaw.

## 🎯 Overview

This system provides:
- **Conversational Voice Interface** - Natural dialogue with ChatGPT Voice-like experience
- **Command Recognition** - Detects chat vs command intents automatically
- **Multi-System Integration** - Telegram, Agent Zero, OpenClaw adapters
- **Security First** - Permissions, rate limiting, audit logging

## 📁 Project Structure

```
voice_interface/
├── TECHNICAL_SPECIFICATION.md    # Full technical specification
├── schemas/
│   └── action_plan.py           # Pydantic models for action plans
├── adapters/
│   ├── telegram.py              # Telegram Bot API client
│   ├── agent_zero.py            # Agent Zero HTTP/WebSocket client
│   └── openclaw.py              # OpenClaw orchestration client
├── security/
│   ├── permissions.py           # Role-based permission system
│   ├── rate_limiter.py          # Token bucket rate limiting
│   └── replay_protection.py     # Nonce-based replay attack prevention
├── engine/
│   ├── intent.py                # CHAT/COMMAND/AMBIGUOUS classifier
│   └── policy.py                # Confirmation rules validator
├── audit/
│   └── logger.py                # SQLite-based audit logging
└── tests/
    ├── integration/             # Integration tests
    ├── adversarial/             # Security/prompt injection tests
    └── performance/             # Latency benchmarks
```

## 🚀 Quick Start (MVP)

### 1. Install Dependencies

```bash
pip install pydantic httpx websockets
```

For local STT/TTS:
```bash
# macOS
brew install whisper-cpp piper-tts

# Or use pip for Python bindings
pip install pyaudio webrtcvad
```

### 2. Configure Secrets

```python
from security import PermissionSet
from adapters import TelegramAdapter, AgentZeroAdapter, OpenClawAdapter

# Initialize adapters
telegram = TelegramAdapter(api_token="your-telegram-bot-token")
agent_zero = AgentZeroAdapter(base_url="http://localhost:8000")
openclaw = OpenClawAdapter(
    ws_url="ws://localhost:9000/ws",
    http_url="http://localhost:9000"
)

# Set permissions
permissions = PermissionSet(role="power_user")
```

### 3. Classify and Execute

```python
from engine import IntentClassifier, PolicyValidator
from schemas import ActionPlan

classifier = IntentClassifier()
validator = PolicyValidator()

# Classify user utterance
utterance = "Send a message to John on Telegram saying I'll be 10 minutes late"
result = classifier.classify(utterance)

print(f"Mode: {result.mode}")        # COMMAND
print(f"Intent: {result.intent}")    # telegram_send_message
print(f"Entities: {result.entities}")  # {"recipient": "John", "message": "I'll be 10 minutes late"}

# Create action plan
action_plan = {
    "mode": "COMMAND",
    "confidence": result.confidence,
    "intent": result.intent,
    "targets": [{"system": "telegram", "resource": "contact:John", "action": "send_message"}],
    "parameters": result.entities,
    "requires_confirmation": validator.requires_confirmation({"parameters": result.entities}),
}

# Check if confirmation needed
if action_plan["requires_confirmation"]:
    prompt = validator.get_confirmation_prompt(action_plan)
    print(f"Confirm: {prompt}")
else:
    print("Safe to execute directly")
```

### 4. Execute with Audit

```python
from audit import AuditLogger
import asyncio

async def execute_and_log(utterance: str):
    audit = AuditLogger(Path("audit.db"))

    # Classify
    result = classifier.classify(utterance)

    # Execute if command
    if result.mode == "COMMAND" and result.confidence > 0.8:
        # Create action plan and execute...
        response = await telegram.send_message(...)

        # Log to audit
        audit.log_action(
            trace_id=str(uuid.uuid4()),
            user_utterance=utterance,
            action_plan=action_plan,
            tool_calls=[{"tool": "telegram_send", "input": {...}}],
            tool_responses=[response.model_dump()],
            success=response.success
        )

    return result
```

## 🔐 Security Model

### Permission Levels

| Role | Telegram | Agent Zero | OpenClaw |
|------|----------|------------|----------|
| user | Read, Send Contact | Execute | Execute |
| power_user | + Send Group | Execute | Execute |
| admin | + Public, Delete | + Admin | + Admin |

### Confirmation Rules

Actions requiring explicit confirmation:
- Sending to new Telegram recipients
- Sending to large groups (>50 members)
- Posting to public channels
- Deleting messages
- Changing credentials/API keys
- Modifying remote systems

### Rate Limits

| System | Requests | Window |
|--------|----------|--------|
| Telegram | 30 | 60s |
| Agent Zero | 10 | 60s |
| OpenClaw | 20 | 60s |

## 📊 Latency Targets

| Stage | p50 | p95 | p99 |
|-------|-----|-----|-----|
| Intent Classification | 100ms | 200ms | 400ms |
| Policy Check | 5ms | 10ms | 20ms |
| Tool Execution | 200ms | 1s | 3s |
| **Total (no tool)** | **~1.2s** | **~1.8s** | **~2.8s** |

## 🧪 Testing

```bash
# Unit tests
pytest tests/unit/

# Integration tests
pytest tests/integration/

# Adversarial tests
pytest tests/adversarial/

# Performance benchmarks
pytest tests/performance/ --benchmark-only
```

## 📝 Action Plan Examples

See `TECHNICAL_SPECIFICATION.md` for complete examples:

1. **Telegram Send** - Send message to contact
2. **Telegram Group** - Send to group (with confirmation)
3. **Agent Zero Task** - Execute research task
4. **OpenClaw Multi-Tool** - Chain multiple tool calls
5. **Mixed System** - Telegram + Agent Zero workflow

## 🔧 Configuration

### Environment Variables

```bash
export TELEGRAM_BOT_TOKEN="your-token"
export AGENT_ZERO_URL="http://localhost:8000"
export AGENT_ZERO_API_KEY="your-key"
export OPENCLAW_WS_URL="ws://localhost:9000/ws"
export OPENCLAW_HTTP_URL="http://localhost:9000"
export OPENCLAW_AUTH_TOKEN="your-token"
export OPENAI_API_KEY="sk-..."
export OPENAI_REALTIME_MODEL="gpt-4o-realtime-preview"
export OPENAI_REALTIME_URL="wss://api.openai.com/v1/realtime"
export AGENT_ZERO_EXECUTOR="http"  # use "mock" for local simulation
export TASK_STORE="redis"  # use "memory" for non-persistent local mode
export REDIS_URL="redis://localhost:6379/0"
```

## 🎙️ Realtime Orchestrator Proxy

The backend now supports a Realtime API proxy where GPT-4o is the conversational brain and Agent Zero is an async execution tool:

- WebSocket proxy: `ws://<host>:8000/ws/realtime/{conversation_id}`
- Task API: `POST /api/tasks`, `GET /api/tasks`, `GET /api/tasks/{task_id}`, `POST /api/tasks/{task_id}/update`, `POST /api/tasks/{task_id}/cancel`
- Built-in tool schema for GPT-4o: `create_task`, `list_tasks`, `check_task_status`, `update_task`, `cancel_task`
- Persistent task storage: set `TASK_STORE=redis` (with `REDIS_URL`) to recover in-flight tasks after backend restarts

At session start, the proxy sends `session.update` with those tools enabled and `server_vad` turn detection by default.

For mobile clients, point transport to your backend:
- `EXPO_PUBLIC_API_URL=http://<host>:8000`
- `EXPO_PUBLIC_WS_URL=ws://<host>:8000`

## OpenRouter Audio Models

For audio-capable OpenRouter models (for example `openai/gpt-audio-mini`), use the audio route:
- `POST /api/voice/process-audio` with multipart `file` + `session_id`
- Backend tries OpenRouter Responses audio input first, then falls back to transcription + text generation
- Text-only `POST /api/voice/process` remains available for keyboard/chat flows

Recommended env for audio models:
- `OPENROUTER_MODEL=openai/gpt-audio-mini`
- `OPENROUTER_API_MODE=responses` (or `auto`)
- `OPENROUTER_RESPONSES_MODALITIES=text`

## Local Whisper Fallback

`POST /api/voice/transcribe` uses Z.AI transcription when `ZAI_API_KEY` is set.  
If `ZAI_API_KEY` is missing, the backend falls back to local `faster-whisper` on CPU by default.

Environment variables:
- `LOCAL_WHISPER_ENABLED` (default: `true`)
- `LOCAL_WHISPER_MODEL` (default: `tiny.en`)
- `LOCAL_WHISPER_DEVICE` (default: `cpu`)
- `LOCAL_WHISPER_COMPUTE_TYPE` (default: `int8`)
- `LOCAL_WHISPER_LANGUAGE` (default: `en`)
- `LOCAL_WHISPER_BEAM_SIZE` (default: `1`)

If local fallback is disabled (`LOCAL_WHISPER_ENABLED=false`) and `ZAI_API_KEY` is not configured, transcription returns a clear runtime error.

### Permission Config (permissions.yaml)

```yaml
roles:
  user:
    permissions:
      - telegram_read
      - telegram_send_contact
      - agent_zero_execute
      - openclaw_execute

  admin:
    inherits: user
    permissions:
      - telegram_send_public
      - telegram_delete
      - agent_zero_admin
```

## 📚 Documentation

- **TECHNICAL_SPECIFICATION.md** - Complete architecture and API contracts
- **API Contracts** - TypeScript/Python type definitions in adapter files
- **Security Model** - Auth, secrets, permissions in security/ module

## 🗺️ Roadmap

### MVP (Week 1-2)
- [x] Push-to-talk activation
- [x] Whisper.cpp STT
- [x] Piper TTS
- [x] Basic intent classification
- [x] Telegram send command
- [x] SQLite audit logging

### V1 (Week 3-4)
- [ ] Full Telegram integration (read, search, summarize)
- [ ] Agent Zero task execution
- [ ] OpenClaw tool orchestration
- [ ] Entity extraction (NER)
- [ ] Multi-step action plans

### V2 (Week 5-6)
- [ ] Hotword detection ("Hey Assistant")
- [ ] Cloud STT/TTS fallbacks
- [ ] Multi-user authentication
- [ ] Docker deployment
- [ ] Prometheus metrics

## 📄 License

MIT License
