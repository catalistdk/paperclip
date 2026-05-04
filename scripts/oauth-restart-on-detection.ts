#!/usr/bin/env -S node --import tsx
import { spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { resolveDatabaseTarget } from "../packages/db/src/runtime-config.ts";

type Args = {
  apply: boolean;
  allowActiveRuns: boolean;
  confirmRestart: boolean;
  help: boolean;
  sinceMinutes: number;
  limit: number;
  cooldownMinutes: number;
  restartCommand: string;
  lockFile: string;
  stateFile: string;
  simulateRunJson: string | null;
};

type AuthFailureRun = {
  id: string;
  company_id: string;
  agent_id: string;
  status: string;
  error_code: string | null;
  error: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date | null;
  created_at: Date;
  context_snapshot: Record<string, unknown> | null;
};

type ActiveHold = {
  hold_id: string;
  root_issue_id: string;
  issue_id: string;
  mode: string;
  reason: string | null;
};

type ActiveRun = {
  id: string;
  company_id: string;
  agent_id: string;
  status: string;
  issue_id: string | null;
  started_at: Date | null;
  created_at: Date;
};

const DEFAULT_RESTART_COMMAND = "pnpm dev:stop && nohup pnpm dev > .paperclip/oauth-restart.log 2>&1 &";
const AUTH_FAILURE_RE = /invalid authentication credentials|api error:\s*401|\b401\b/i;

function usage() {
  console.log(`Usage:
  scripts/oauth-restart-on-detection.ts [--dry-run] [--apply --confirm-restart]

Detects the Paperclip OAuth/auth failure signal from heartbeat_runs:
  status='failed' AND error_code='adapter_failed' AND error contains 401 or Invalid authentication credentials

Options:
  --dry-run                    Print detection and restart plan only. This is the default.
  --apply                      Execute the restart command when a signal is found.
  --confirm-restart            Required with --apply so restart is operator-confirmed.
  --allow-active-runs          Do not suppress restart when queued/running heartbeat_runs exist.
  --since-minutes N            Detection window. Default: 1440.
  --limit N                    Max failed runs to inspect/report. Default: 20.
  --cooldown-minutes N         Refuse repeat restarts inside this window. Default: 15.
  --restart-command CMD        Command to run on confirmed apply.
                               Default: ${DEFAULT_RESTART_COMMAND}
  --lock-file PATH             Recursion guard lock. Default: .paperclip/oauth-restart.lock.
  --state-file PATH            Cooldown marker. Default: .paperclip/oauth-restart-state.json.
  --simulate-run-json PATH     Validate detection against a JSON file instead of the DB.
  --help                       Show this text.

Exit codes:
  0: no restart executed or restart command succeeded
  2: auth failure detected in dry-run mode
  3: restart suppressed by lock/cooldown/active pause hold
  4: restart command failed`);
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const defaultsDir = path.resolve(process.cwd(), ".paperclip");
  const args: Args = {
    apply: false,
    allowActiveRuns: false,
    confirmRestart: false,
    help: false,
    sinceMinutes: 24 * 60,
    limit: 20,
    cooldownMinutes: 15,
    restartCommand: DEFAULT_RESTART_COMMAND,
    lockFile: path.join(defaultsDir, "oauth-restart.lock"),
    stateFile: path.join(defaultsDir, "oauth-restart-state.json"),
    simulateRunJson: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run":
        args.apply = false;
        break;
      case "--apply":
        args.apply = true;
        break;
      case "--allow-active-runs":
        args.allowActiveRuns = true;
        break;
      case "--confirm-restart":
        args.confirmRestart = true;
        break;
      case "--since-minutes":
        args.sinceMinutes = parsePositiveInt(argv[++i], args.sinceMinutes, "--since-minutes");
        break;
      case "--limit":
        args.limit = parsePositiveInt(argv[++i], args.limit, "--limit");
        break;
      case "--cooldown-minutes":
        args.cooldownMinutes = parsePositiveInt(argv[++i], args.cooldownMinutes, "--cooldown-minutes");
        break;
      case "--restart-command":
        args.restartCommand = argv[++i] ?? "";
        if (!args.restartCommand.trim()) throw new Error("--restart-command requires a command");
        break;
      case "--lock-file":
        args.lockFile = path.resolve(argv[++i] ?? "");
        if (!args.lockFile) throw new Error("--lock-file requires a path");
        break;
      case "--state-file":
        args.stateFile = path.resolve(argv[++i] ?? "");
        if (!args.stateFile) throw new Error("--state-file requires a path");
        break;
      case "--simulate-run-json":
        args.simulateRunJson = path.resolve(argv[++i] ?? "");
        if (!args.simulateRunJson) throw new Error("--simulate-run-json requires a path");
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readIssueIdFromContext(context: unknown) {
  const object = asObject(context);
  const issueId = object?.issueId ?? object?.taskId;
  return typeof issueId === "string" && issueId.length > 0 ? issueId : null;
}

function isAuthFailureRun(run: Pick<AuthFailureRun, "status" | "error_code" | "error">) {
  return run.status === "failed" &&
    run.error_code?.toLowerCase() === "adapter_failed" &&
    AUTH_FAILURE_RE.test(run.error ?? "");
}

function newestRunTime(run: Pick<AuthFailureRun, "finished_at" | "updated_at" | "created_at">) {
  return run.finished_at ?? run.updated_at ?? run.created_at;
}

async function detectFromDatabase(args: Args) {
  const target = resolveDatabaseTarget();
  const connectionString = target.mode === "postgres"
    ? target.connectionString
    : `postgres://paperclip:paperclip@127.0.0.1:${target.port}/paperclip`;
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

  try {
    const runs = await sql<AuthFailureRun[]>`
      SELECT
        id,
        company_id,
        agent_id,
        status,
        error_code,
        error,
        started_at,
        finished_at,
        updated_at,
        created_at,
        context_snapshot
      FROM heartbeat_runs
      WHERE status = 'failed'
        AND error_code = 'adapter_failed'
        AND error ~* '(invalid authentication credentials|api error:\\s*401|\\m401\\M)'
        AND COALESCE(finished_at, updated_at, created_at) >= NOW() - (${args.sinceMinutes} || ' minutes')::interval
      ORDER BY COALESCE(finished_at, updated_at, created_at) DESC
      LIMIT ${args.limit}
    `;
    const issueIds = [...new Set(runs.map((run) => readIssueIdFromContext(run.context_snapshot)).filter(Boolean))] as string[];
    const holds = issueIds.length > 0
      ? await sql<ActiveHold[]>`
          SELECT
            h.id AS hold_id,
            h.root_issue_id,
            m.issue_id,
            h.mode,
            h.reason
          FROM issue_tree_holds h
          INNER JOIN issue_tree_hold_members m ON m.hold_id = h.id
          WHERE h.status = 'active'
            AND h.mode = 'pause'
            AND m.issue_id IN ${sql(issueIds)}
        `
      : [];
    const activeRuns = await sql<ActiveRun[]>`
      SELECT
        id,
        company_id,
        agent_id,
        status,
        context_snapshot->>'issueId' AS issue_id,
        started_at,
        created_at
      FROM heartbeat_runs
      WHERE status IN ('queued', 'running')
      ORDER BY COALESCE(started_at, created_at) DESC
      LIMIT 20
    `;

    return { source: target.source, runs, holds, activeRuns };
  } finally {
    await sql.end();
  }
}

function detectFromSimulation(args: Args) {
  if (!args.simulateRunJson) throw new Error("Missing simulation file");
  const parsed = JSON.parse(readFileSync(args.simulateRunJson, "utf8"));
  const rawRuns = Array.isArray(parsed) ? parsed : [parsed];
  const now = new Date();
  const cutoff = now.getTime() - args.sinceMinutes * 60 * 1000;
  const runs = rawRuns
    .map((value): AuthFailureRun => {
      const object = asObject(value) ?? {};
      return {
        id: String(object.id ?? "simulated-run"),
        company_id: String(object.company_id ?? object.companyId ?? "simulated-company"),
        agent_id: String(object.agent_id ?? object.agentId ?? "simulated-agent"),
        status: String(object.status ?? ""),
        error_code: typeof object.error_code === "string" ? object.error_code : typeof object.errorCode === "string" ? object.errorCode : null,
        error: typeof object.error === "string" ? object.error : null,
        started_at: object.started_at ? new Date(String(object.started_at)) : null,
        finished_at: object.finished_at ? new Date(String(object.finished_at)) : null,
        updated_at: object.updated_at ? new Date(String(object.updated_at)) : null,
        created_at: object.created_at ? new Date(String(object.created_at)) : now,
        context_snapshot: asObject(object.context_snapshot ?? object.contextSnapshot),
      };
    })
    .filter((run) => isAuthFailureRun(run) && newestRunTime(run).getTime() >= cutoff)
    .slice(0, args.limit);

  return { source: `simulation:${args.simulateRunJson}`, runs, holds: [] as ActiveHold[], activeRuns: [] as ActiveRun[] };
}

function acquireLock(lockFile: string) {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  let fd: number | null = null;
  try {
    fd = openSync(lockFile, "wx");
    writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), host: os.hostname() }));
    return () => {
      if (fd !== null) {
        try {
          rmSync(lockFile, { force: true });
        } finally {
          fd = null;
        }
      }
    };
  } catch (err) {
    throw new Error(`Recovery already appears to be running; lock exists at ${lockFile}. Remove it only after confirming no restart is active.`);
  }
}

function readLastRestartAt(stateFile: string) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    const value = typeof parsed.lastRestartAt === "string" ? new Date(parsed.lastRestartAt) : null;
    return value && !Number.isNaN(value.getTime()) ? value : null;
  } catch {
    return null;
  }
}

function writeRestartState(stateFile: string, runs: AuthFailureRun[]) {
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify(
      {
        lastRestartAt: new Date().toISOString(),
        reason: "oauth_adapter_failed_401",
        runIds: runs.map((run) => run.id),
      },
      null,
      2,
    ),
  );
}

function printRuns(runs: AuthFailureRun[]) {
  for (const run of runs) {
    const issueId = readIssueIdFromContext(run.context_snapshot) ?? "unknown issue";
    const when = newestRunTime(run).toISOString();
    console.log(`- run=${run.id} company=${run.company_id} agent=${run.agent_id} issue=${issueId} at=${when}`);
    console.log(`  signal=${run.error_code}: ${run.error}`);
  }
}

function printActiveRuns(activeRuns: ActiveRun[]) {
  for (const run of activeRuns) {
    const when = (run.started_at ?? run.created_at).toISOString();
    console.log(`- run=${run.id} company=${run.company_id} agent=${run.agent_id} issue=${run.issue_id ?? "unknown issue"} status=${run.status} at=${when}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (args.apply && !args.confirmRestart) {
    throw new Error("--apply requires --confirm-restart");
  }

  const detection = args.simulateRunJson ? detectFromSimulation(args) : await detectFromDatabase(args);
  console.log(`OAuth detection source: ${detection.source}`);
  console.log(`Detection window: last ${args.sinceMinutes} minute(s)`);

  if (detection.runs.length === 0) {
    console.log("No OAuth/auth 401 adapter_failed heartbeat_runs found.");
    return;
  }

  console.log(`Detected ${detection.runs.length} OAuth/auth failure run(s):`);
  printRuns(detection.runs);

  if (detection.holds.length > 0) {
    console.log("Restart suppressed because affected issue(s) are under an active pause hold:");
    for (const hold of detection.holds) {
      console.log(`- hold=${hold.hold_id} root=${hold.root_issue_id} issue=${hold.issue_id} mode=${hold.mode} reason=${hold.reason ?? ""}`);
    }
    process.exitCode = 3;
    return;
  }

  if (detection.activeRuns.length > 0 && !args.allowActiveRuns) {
    console.log("Restart suppressed because queued/running heartbeat_run(s) exist:");
    printActiveRuns(detection.activeRuns);
    console.log("Re-run with --allow-active-runs only after manually confirming these runs are stale, expendable, or already represented by a post-recovery hold.");
    process.exitCode = 3;
    return;
  }

  const lastRestartAt = readLastRestartAt(args.stateFile);
  if (lastRestartAt) {
    const ageMs = Date.now() - lastRestartAt.getTime();
    const cooldownMs = args.cooldownMinutes * 60 * 1000;
    if (ageMs < cooldownMs) {
      console.log(`Restart suppressed by cooldown. Last restart: ${lastRestartAt.toISOString()}; cooldown: ${args.cooldownMinutes} minute(s).`);
      process.exitCode = 3;
      return;
    }
  }

  console.log(`Restart command: ${args.restartCommand}`);
  if (!args.apply) {
    console.log("Dry run only. Re-run with --apply --confirm-restart to execute the restart command.");
    process.exitCode = 2;
    return;
  }

  const releaseLock = acquireLock(args.lockFile);
  try {
    console.log("Executing confirmed restart command...");
    const result = spawnSync(args.restartCommand, {
      cwd: process.cwd(),
      shell: true,
      stdio: "inherit",
      env: process.env,
    });
    if (result.status !== 0) {
      console.error(`Restart command failed with status ${result.status ?? "unknown"}.`);
      process.exitCode = 4;
      return;
    }
    writeRestartState(args.stateFile, detection.runs);
    console.log("Restart command completed and cooldown state was recorded.");
  } finally {
    releaseLock();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
