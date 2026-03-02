# SnapClaw Agent Swarm Workflow

## Purpose
Coordinate Codex/Claude agents across isolated worktrees, track tasks in JSON, auto-run local checks, and surface only actionable status.

## Task Registry
`.clawdbot/active-tasks.json` stores lifecycle state for each task: branch, worktree, tmux session, status, test status, PR, and notes.

## Launch
```bash
.clawdbot/launch-agent.sh \
  --id feat-auth-fix \
  --agent codex \
  --repo /home/jared/.agentzero-data/workdir/SnapClaw \
  --worktree ../snapclaw-worktrees/feat-auth-fix \
  --branch feat/auth-fix \
  --description "Fix auth refresh edge case and add validation" \
  --test-cmd "python -m compileall backend" \
  --notify-on-complete true \
  --model gpt-5.3-codex \
  --reasoning high \
  --risk med
```

`--test-cmd` is optional. If omitted, launch uses `.clawdbot/swarm-config.json` `defaultTestCommand` and falls back to `python -m pytest -q`.

`--notify-on-complete` controls whether that task is included in READY/BLOCKED summary notifications (`true` by default).

## Steer
```bash
.clawdbot/steer-agent.sh --agent codex --id feat-auth-fix \
  --message "Stop UI changes. Focus backend token validation and return tests/logs."
```

## Monitor
```bash
.clawdbot/check-agents.sh
```
Checks tmux liveness, PR presence, local test status, and CI status, then updates registry state.

Run every 10 minutes via cron (recommended):
```bash
*/10 * * * * PATH=/home/jared/.npm-global/bin:/usr/local/bin:/usr/bin:/bin; cd /home/jared/.agentzero-data/workdir/SnapClaw && ./.clawdbot/check-agents.sh >> ./.clawdbot/logs/monitor.log 2>&1
```

Auto-test behavior:
- For tasks in `running` state, when the tmux session exits and `testStatus` is still `pending`, the script runs `testCommand` in the task worktree.
- Timeout comes from `.clawdbot/swarm-config.json` `testTimeoutSeconds`.
- Test output is captured to `.clawdbot/logs/<task-id>-test-<timestamp>.log`.
- `testStatus`, `testLastRunAt`, `testLastExitCode`, and `testLogPath` are stored in the task record.

Notification behavior:
- On transitions to `done` or `blocked`, the script sends a summary via `openclaw system event --mode <mode>`.
- Controlled by `.clawdbot/swarm-config.json`:
  - `notify.enabled`
  - `notify.mode`
  - `notify.onlyOnTransitions`
- Notification failures never fail the monitor script.

## Cleanup
```bash
.clawdbot/cleanup.sh
.clawdbot/cleanup.sh --prune-worktrees
```
Removes stale done/failed tasks older than 7 days; optionally prunes worktrees.
