#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="$ROOT_DIR/.clawdbot/active-tasks.json"
CONFIG="$ROOT_DIR/.clawdbot/swarm-config.json"

usage() {
  cat <<EOF
Usage:
  $0 --id <task-id> --agent <codex|claude> --repo <repo-path> --worktree <path> --branch <branch> --description <text> [--model <model>] [--reasoning <low|medium|high>] [--risk <low|med|high>] [--test-cmd <cmd>] [--notify-on-complete <true|false>]
EOF
}

ID=""; AGENT=""; REPO=""; WORKTREE=""; BRANCH=""; DESCRIPTION=""; MODEL=""; REASONING="medium"; RISK="med"
TEST_CMD=""; NOTIFY_ON_COMPLETE="true"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id) ID="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --worktree) WORKTREE="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --description) DESCRIPTION="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --reasoning) REASONING="$2"; shift 2 ;;
    --risk) RISK="$2"; shift 2 ;;
    --test-cmd) TEST_CMD="$2"; shift 2 ;;
    --notify-on-complete) NOTIFY_ON_COMPLETE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1"; usage; exit 1 ;;
  esac
done

if [[ -z "$ID" || -z "$AGENT" || -z "$REPO" || -z "$WORKTREE" || -z "$BRANCH" || -z "$DESCRIPTION" ]]; then
  usage
  exit 1
fi

if [[ "$AGENT" != "codex" && "$AGENT" != "claude" ]]; then
  echo "--agent must be codex or claude"
  exit 1
fi

if [[ "$NOTIFY_ON_COMPLETE" != "true" && "$NOTIFY_ON_COMPLETE" != "false" ]]; then
  echo "--notify-on-complete must be true or false"
  exit 1
fi

mkdir -p "$ROOT_DIR/.clawdbot"
if [[ ! -f "$REGISTRY" ]]; then
  cat > "$REGISTRY" <<'JSON'
{"version":"1.0","updatedAt":"","tasks":[]}
JSON
fi

DEFAULT_TEST_CMD="$(python3 - "$CONFIG" <<'PY'
import json
import sys
from pathlib import Path

cfg_path = Path(sys.argv[1])
default = "python -m pytest -q"
if not cfg_path.exists():
    print(default)
    raise SystemExit(0)
try:
    with cfg_path.open("r", encoding="utf-8") as f:
        cfg = json.load(f)
except Exception:
    print(default)
    raise SystemExit(0)
value = cfg.get("defaultTestCommand")
print(value if isinstance(value, str) and value.strip() else default)
PY
)"

if [[ -z "$TEST_CMD" ]]; then
  TEST_CMD="$DEFAULT_TEST_CMD"
fi

REPO="$(realpath "$REPO")"
if [[ ! -d "$REPO/.git" ]]; then
  echo "Repo is not a git repository: $REPO"
  exit 1
fi

if [[ "$WORKTREE" != /* ]]; then
  WORKTREE="$REPO/$WORKTREE"
fi
WORKTREE="$(realpath -m "$WORKTREE")"

# Create worktree if needed
if [[ ! -d "$WORKTREE" ]]; then
  git -C "$REPO" fetch origin master >/dev/null 2>&1 || true
  git -C "$REPO" worktree add "$WORKTREE" -B "$BRANCH" origin/master
fi

SESSION="${AGENT}-${ID}"

# Build safe default command
if [[ "$AGENT" == "codex" ]]; then
  MODEL_ARG=""
  REASON_ARG=""
  [[ -n "$MODEL" ]] && MODEL_ARG="--model $MODEL"
  [[ -n "$REASONING" ]] && REASON_ARG="-c model_reasoning_effort=$REASONING"
  CMD="codex exec --full-auto $MODEL_ARG $REASON_ARG \"$DESCRIPTION\""
else
  CLAUDE_MODEL="${MODEL:-sonnet}"
  CMD="claude --model $CLAUDE_MODEL --permission-mode acceptEdits -p \"$DESCRIPTION\""
fi

# Start tmux session if not running
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session already exists: $SESSION"
else
  tmux new-session -d -s "$SESSION" -c "$WORKTREE" "$CMD"
fi

python3 - "$REGISTRY" "$ID" "$SESSION" "$AGENT" "$DESCRIPTION" "$REPO" "$WORKTREE" "$BRANCH" "$RISK" "$REASONING" "$TEST_CMD" "$NOTIFY_ON_COMPLETE" <<'PY'
import json
import sys
from datetime import datetime, timezone

(
    registry,
    task_id,
    session,
    agent,
    description,
    repo,
    worktree,
    branch,
    risk,
    reasoning,
    test_command,
    notify_on_complete,
) = sys.argv[1:]
now = datetime.now(timezone.utc).isoformat()

with open(registry, "r", encoding="utf-8") as f:
    data = json.load(f)

tasks = data.setdefault("tasks", [])
existing = None
for t in tasks:
    if t.get("id") == task_id:
        existing = t
        break

record = {
    "id": task_id,
    "tmuxSession": session,
    "agent": agent,
    "description": description,
    "repo": repo,
    "worktree": worktree,
    "branch": branch,
    "riskLevel": risk,
    "reasoning": reasoning,
    "startedAt": now,
    "updatedAt": now,
    "status": "running",
    "attempts": int(existing.get("attempts", 0) + 1) if existing else 1,
    "testCommand": test_command,
    "testStatus": "pending",
    "testLastRunAt": None,
    "testLastExitCode": None,
    "testLogPath": None,
    "notifyOnComplete": notify_on_complete.lower() == "true",
    "note": "launched"
}

if existing:
    existing.update(record)
else:
    tasks.append(record)

data["updatedAt"] = now
with open(registry, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

echo "Launched: $SESSION"
echo "Worktree: $WORKTREE"
