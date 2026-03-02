#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="$ROOT_DIR/.clawdbot/active-tasks.json"
CONFIG="$ROOT_DIR/.clawdbot/swarm-config.json"
LOG_DIR="$ROOT_DIR/.clawdbot/logs"

if [[ ! -f "$REGISTRY" ]]; then
  echo "No registry file found: $REGISTRY"
  echo "ID AGENT STATUS TEST PR NOTE"
  exit 0
fi

python3 - "$REGISTRY" "$CONFIG" "$LOG_DIR" <<'PY'
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

registry, config_path, log_dir = sys.argv[1:]

with open(registry, "r", encoding="utf-8") as f:
    data = json.load(f)

cfg = {
    "defaultTestCommand": "python -m pytest -q",
    "testTimeoutSeconds": 1200,
    "notify": {
        "enabled": True,
        "mode": "now",
        "onlyOnTransitions": True,
    },
}
if os.path.exists(config_path):
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            loaded = json.load(f)
        if isinstance(loaded.get("defaultTestCommand"), str) and loaded["defaultTestCommand"].strip():
            cfg["defaultTestCommand"] = loaded["defaultTestCommand"]
        if isinstance(loaded.get("testTimeoutSeconds"), int):
            cfg["testTimeoutSeconds"] = loaded["testTimeoutSeconds"]
        if isinstance(loaded.get("notify"), dict):
            for key in ("enabled", "mode", "onlyOnTransitions"):
                if key in loaded["notify"]:
                    cfg["notify"][key] = loaded["notify"][key]
    except Exception:
        pass

os.makedirs(log_dir, exist_ok=True)
tasks = data.get("tasks", [])
has_gh = shutil.which("gh") is not None
now = datetime.now(timezone.utc).isoformat()
ready_lines = []
blocked_lines = []

def detect_ci_state(repo, pr_number):
    chk = subprocess.run(
        ["gh", "pr", "checks", str(pr_number)],
        capture_output=True,
        text=True,
        cwd=repo,
        check=False,
    )
    if chk.returncode == 0:
        return "passing", "ci passed"
    out = (chk.stdout + "\n" + chk.stderr).lower()
    if "pending" in out or "in progress" in out:
        return "pending", "ci pending"
    return "failing", "ci failing"

for task in tasks:
    prev_status = task.get("status", "running")
    if prev_status not in {"running", "blocked"}:
        continue

    session = task.get("tmuxSession", "")
    branch = task.get("branch", "")
    repo = task.get("repo", ".")
    task_id = task.get("id", "task")

    # 1) tmux liveness
    alive = subprocess.run(["tmux", "has-session", "-t", session], capture_output=True).returncode == 0

    # 2) PR + checks
    pr_number = task.get("pr")
    checks_passed = None
    checks_note = ""

    if has_gh and branch:
        try:
            pr_list = subprocess.run(
                ["gh", "pr", "list", "--head", branch, "--json", "number,state", "-L", "1"],
                capture_output=True,
                text=True,
                check=False,
                cwd=repo,
            )
            if pr_list.returncode == 0 and pr_list.stdout.strip():
                prs = json.loads(pr_list.stdout)
                if prs:
                    pr_number = prs[0].get("number")
        except Exception:
            pass

    if has_gh and pr_number is not None:
        task["pr"] = pr_number
        try:
            ci_state, checks_note = detect_ci_state(repo, pr_number)
            checks_passed = True if ci_state == "passing" else (False if ci_state == "failing" else None)
        except Exception:
            pass

    # 3) local tests (only when agent session exited while task was running)
    if prev_status == "running" and task.get("testStatus", "pending") == "pending" and not alive:
        command = task.get("testCommand") or cfg["defaultTestCommand"]
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        rel_log = f".clawdbot/logs/{task_id}-test-{ts}.log"
        abs_log = os.path.join(log_dir, f"{task_id}-test-{ts}.log")
        exit_code = 1
        output = ""
        try:
            result = subprocess.run(
                command,
                cwd=task.get("worktree", repo),
                shell=True,
                capture_output=True,
                text=True,
                timeout=int(cfg["testTimeoutSeconds"]),
                check=False,
            )
            exit_code = result.returncode
            output = (result.stdout or "") + (result.stderr or "")
        except subprocess.TimeoutExpired as exc:
            exit_code = 124
            output = (exc.stdout or "") + (exc.stderr or "") + "\nTimed out running test command.\n"
        except Exception as exc:
            exit_code = 1
            output = f"Failed to run test command: {exc}\n"

        with open(abs_log, "w", encoding="utf-8") as f:
            f.write(output)
        task["testStatus"] = "passed" if exit_code == 0 else "failed"
        task["testLastRunAt"] = datetime.now(timezone.utc).isoformat()
        task["testLastExitCode"] = exit_code
        task["testLogPath"] = rel_log

    # 4) state transitions
    if pr_number is not None and checks_passed is True:
        new_status = "done"
        note = "PR ready; CI passing"
    elif task.get("testStatus") == "failed":
        new_status = "blocked"
        note = "local tests failed"
    elif not alive and pr_number is None:
        new_status = "blocked"
        note = "agent session exited before PR"
    else:
        new_status = "running"
        note = checks_note or ("in progress" if alive else "waiting")

    task["status"] = new_status
    task["note"] = note
    task["updatedAt"] = now

    notify_enabled_for_task = bool(task.get("notifyOnComplete", True))
    only_on_transitions = bool(cfg["notify"].get("onlyOnTransitions", True))
    transition_match = prev_status != new_status
    should_emit = notify_enabled_for_task and (transition_match or not only_on_transitions)
    if should_emit and new_status in {"done", "blocked"}:
        summary = f"{task.get('id', '')} ({task.get('agent', '')}) - {note}"
        if new_status == "done":
            ready_lines.append(summary)
        else:
            blocked_lines.append(summary)

# Persist

data["updatedAt"] = now
with open(registry, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")

# Transition-aware notifications
notify_cfg = cfg.get("notify", {})
if bool(notify_cfg.get("enabled", True)) and (ready_lines or blocked_lines):
    text_lines = ["Agent Swarm:"]
    if ready_lines:
        text_lines.append("READY:")
        text_lines.extend(f"- {line}" for line in ready_lines)
    if blocked_lines:
        text_lines.append("BLOCKED:")
        text_lines.extend(f"- {line}" for line in blocked_lines)
    mode = str(notify_cfg.get("mode", "now"))
    try:
        subprocess.run(
            ["openclaw", "system", "event", "--mode", mode, "--text", "\n".join(text_lines)],
            capture_output=True,
            check=False,
        )
    except Exception:
        pass

# Console summary
print(f"{'ID':<22} {'AGENT':<8} {'STATUS':<8} {'TEST':<8} {'PR':<6} NOTE")
print("-" * 100)
for t in tasks:
    print(
        f"{t.get('id', '')[:22]:<22} "
        f"{t.get('agent', ''):<8} "
        f"{t.get('status', ''):<8} "
        f"{t.get('testStatus', '-'): <8} "
        f"{str(t.get('pr', '')):<6} "
        f"{t.get('note', '')}"
    )
PY
