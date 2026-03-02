#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="$ROOT_DIR/.clawdbot/active-tasks.json"
PRUNE_WORKTREES=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prune-worktrees) PRUNE_WORKTREES=true; shift ;;
    -h|--help)
      echo "Usage: $0 [--prune-worktrees]"
      exit 0 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

python3 - "$REGISTRY" "$PRUNE_WORKTREES" <<'PY'
import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta

registry, prune = sys.argv[1], sys.argv[2].lower() == "true"

if not os.path.exists(registry):
    print(f"No registry at {registry}")
    raise SystemExit(0)

with open(registry, "r", encoding="utf-8") as f:
    data = json.load(f)

tasks = data.get("tasks", [])
cutoff = datetime.now(timezone.utc) - timedelta(days=7)
kept = []
removed = []

for t in tasks:
    status = t.get("status", "")
    ts = t.get("updatedAt") or t.get("completedAt") or t.get("startedAt")
    keep = True
    if status in {"done", "failed"} and ts:
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            if dt < cutoff:
                keep = False
        except Exception:
            pass

    if keep:
        kept.append(t)
    else:
        removed.append(t)
        if prune:
            repo = t.get("repo")
            wt = t.get("worktree")
            if repo and wt and os.path.exists(wt):
                subprocess.run(["git", "-C", repo, "worktree", "remove", "--force", wt], check=False)

for t in removed:
    print(f"removed task {t.get('id')} ({t.get('status')})")

data["tasks"] = kept
data["updatedAt"] = datetime.now(timezone.utc).isoformat()

with open(registry, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")

print(f"kept={len(kept)} removed={len(removed)}")
PY
