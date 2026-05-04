# OAuth Restart On Detection

Use this runbook when Paperclip local adapter runs start failing because the server-side Claude OAuth credential has expired.

## Failure Signal

The current canonical signal is a failed `heartbeat_runs` row with:

- `status = 'failed'`
- `error_code = 'adapter_failed'`
- `error` containing `401`, `API Error: 401`, or `Invalid authentication credentials`

This is an adapter-auth failure. It is distinct from issue checkout failures, API comment failures, model quota errors, and `/v1/models` probes. Do not use Anthropic `/v1/models` with an OAuth token as a health check.

## Dry Run

From the Paperclip repository root:

```bash
scripts/oauth-restart-on-detection.ts --dry-run --since-minutes 1440
```

Expected outcomes:

- Exit `0`: no matching auth failures found.
- Exit `2`: auth failures found and no restart was executed.
- Exit `3`: auth failures found, but restart was suppressed by an active pause hold, queued/running heartbeat run, or cooldown.
- Exit `4`: confirmed restart command failed.

## Confirmed Restart

Only run the confirmed restart after reading the dry-run output and confirming the affected work can tolerate a server restart:

```bash
scripts/oauth-restart-on-detection.ts --apply --confirm-restart --since-minutes 1440
```

Default restart command:

```bash
pnpm dev:stop && nohup pnpm dev > .paperclip/oauth-restart.log 2>&1 &
```

To use a custom command:

```bash
scripts/oauth-restart-on-detection.ts \
  --apply \
  --confirm-restart \
  --restart-command 'pnpm dev:stop && nohup pnpm dev:watch > /tmp/paperclip.log 2>&1 &'
```

## Safeguards

The script is intentionally conservative:

- `--apply` requires `--confirm-restart`.
- A lock file at `.paperclip/oauth-restart.lock` prevents recursive concurrent restarts.
- `.paperclip/oauth-restart-state.json` enforces the cooldown window.
- Active `issue_tree_holds` with `mode = 'pause'` suppress restart for affected issues, covering post-recovery hold posture.
- Queued or running `heartbeat_runs` suppress restart unless the operator passes `--allow-active-runs`.

Use `--allow-active-runs` only after manually confirming the listed runs are stale, expendable, or already covered by an explicit recovery hold.

## Simulation Check

Use this to validate the signal parser without touching the database:

```bash
tmpfile="$(mktemp)"
cat > "$tmpfile" <<'JSON'
[
  {
    "id": "sim-401",
    "company_id": "company",
    "agent_id": "agent",
    "status": "failed",
    "error_code": "adapter_failed",
    "error": "Failed to authenticate. API Error: 401 Invalid authentication credentials",
    "created_at": "2026-05-03T11:30:00.000Z",
    "context_snapshot": { "issueId": "issue-1" }
  }
]
JSON

scripts/oauth-restart-on-detection.ts --dry-run --simulate-run-json "$tmpfile"
```

The simulated command should exit `2` and print the matched run plus the restart command it would use.

## Post-Restart Verification

After a confirmed restart, do not declare the platform recovered from process liveness alone. Verify:

- `/api/health` returns `200`.
- At least one new `heartbeat_runs` row succeeds after the restart timestamp.
- At least one issue comment or issue update is written after the restart timestamp.
- Previously erroring agents have returned to `idle` or are running healthy post-restart work.

If these checks do not pass, keep the system in hold posture and escalate to the operator with the failed check.
