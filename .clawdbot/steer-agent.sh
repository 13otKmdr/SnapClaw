#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage:
  $0 --session <tmux-session> --message <text>
  $0 --agent <codex|claude> --id <task-id> --message <text>
EOF
}

SESSION=""; AGENT=""; ID=""; MESSAGE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --session) SESSION="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --id) ID="$2"; shift 2 ;;
    --message) MESSAGE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1"; usage; exit 1 ;;
  esac
done

if [[ -z "$MESSAGE" ]]; then
  usage
  exit 1
fi

if [[ -z "$SESSION" ]]; then
  if [[ -z "$AGENT" || -z "$ID" ]]; then
    usage
    exit 1
  fi
  SESSION="${AGENT}-${ID}"
fi

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session not found: $SESSION"
  exit 1
fi

tmux send-keys -t "$SESSION" "$MESSAGE" Enter
echo "Steered $SESSION"
