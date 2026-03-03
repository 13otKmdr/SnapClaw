# SnapClaw Agent Runbook

## Scope

- Runtime repo path: `/home/jared/.agentzero-data/workdir/SnapClaw`
- Do not assume `/home/jared/OpenClaw` is the active SnapClaw runtime.

## Compose + Services

- Use this compose file:
  - `docker compose -f /home/jared/.agentzero-data/workdir/SnapClaw/docker-compose.yml ...`
- Primary services:
  - `snapclaw-web`
  - `voice-backend`
  - `snapclaw-agent-zero`
  - `voice-redis`

## Public Endpoints

- Web app: `https://jared-hp-elitedesk-800-g3-sff.tail58f037.ts.net`
- Backend (HTTPS for WS/API): `https://jared-hp-elitedesk-800-g3-sff.tail58f037.ts.net:8443`
- Realtime websocket path: `/ws/realtime/<conversation_id>`

## Tailscale Serve Requirements

- Verify:
  - `tailscale serve status`
- Required routes:
  - `https://jared-hp-elitedesk-800-g3-sff.tail58f037.ts.net` -> frontend (`127.0.0.1:3001` or current web server)
  - `https://jared-hp-elitedesk-800-g3-sff.tail58f037.ts.net:8443` -> backend (`127.0.0.1:8000`)
- If websocket fails to `wss://...:8443/ws/realtime/...`, restore backend route:
  - `tailscale serve --bg --https=8443 8000`

## Realtime Model + Voice

- Source of truth is `voice-backend` env, not assumptions.
- Current expected values:
  - `OPENAI_REALTIME_MODEL=gpt-realtime`
  - `OPENAI_REALTIME_URL=wss://api.openai.com/v1/realtime`
  - `OPENAI_REALTIME_VOICE=alloy`

## Agent Zero Task Delegation Mode

- This stack uses legacy Agent Zero API routing.
- Required backend env:
  - `AGENT_ZERO_EXECUTOR=a0_legacy`
  - `AGENT_ZERO_CSRF_PATH=/csrf_token`
  - `AGENT_ZERO_MESSAGE_ASYNC_PATH=/message_async`
  - `AGENT_ZERO_POLL_PATH=/poll`
- Do not default this stack to `/api/task` endpoints.

## Known Failure Modes

- Symptom: chat works but no delegated execution.
  - Cause: wrong executor mode (`http` + `/api/task` paths) for this Agent Zero image.
- Symptom: websocket connection failed to `:8443`.
  - Cause: Tailscale Serve route for `:8443` missing.
- Symptom: Agent Zero errors on model calls.
  - Cause: provider keys missing in `snapclaw-agent-zero` env or model provider mismatch.

## Smoke Checks

- Service health:
  - `docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'`
- Backend env check:
  - `docker exec voice-backend env | sort | grep -E 'AGENT_ZERO_EXECUTOR|AGENT_ZERO_CSRF_PATH|AGENT_ZERO_MESSAGE_ASYNC_PATH|AGENT_ZERO_POLL_PATH|OPENAI_REALTIME_MODEL'`
- Websocket quick probe:
  - connect to `wss://jared-hp-elitedesk-800-g3-sff.tail58f037.ts.net:8443/ws/realtime/<test_id>`

## Changes Applied (2026-03-03)

- Added legacy Agent Zero executor integration in backend:
  - file: `backend/orchestration/agent_zero_executor.py`
  - mode: `a0_legacy` using `/csrf_token`, `/message_async`, `/poll`
- Updated compose defaults for backend executor mode and legacy paths:
  - file: `docker-compose.yml`
- Passed Agent Zero execution key env into `snapclaw-agent-zero` container:
  - file: `docker-compose.yml`
- Updated environment examples for legacy mode defaults:
  - file: `.env.example`
- Restored missing Tailscale backend serve route:
  - `tailscale serve --bg --https=8443 8000`

