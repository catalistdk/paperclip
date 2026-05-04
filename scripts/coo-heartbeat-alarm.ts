#!/usr/bin/env -S pnpm exec tsx
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveDatabaseTarget } from "../packages/db/src/runtime-config.ts";
import {
  DEFAULT_COO_HEARTBEAT_THRESHOLD_MS,
  evaluateCooHeartbeatAlarm,
  formatCooHeartbeatAlarmBody,
  parseCooHeartbeatState,
  type CooHeartbeatLogSnapshot,
  type HeartbeatRunSnapshot,
} from "../server/src/services/coo-heartbeat-alarm.ts";
import {
  P0AlertService,
  formatP0AlertMessage,
  loadP0AlertConfigFromEnv,
} from "../server/src/services/p0-alerts.ts";

type Args = {
  dryRun: boolean;
  send: boolean;
  confirmSend: boolean;
  skipDb: boolean;
  help: boolean;
  stateFile: string;
  heartbeatLogFile: string;
  dedupeStateFile: string;
  thresholdMinutes: number;
  now: Date;
  simulateHeartbeatRunsJson: string | null;
  issueId?: string;
  issueIdentifier?: string;
  issueTitle?: string;
};

function usage() {
  console.log(`Usage:
  scripts/coo-heartbeat-alarm.ts [--dry-run]
  scripts/coo-heartbeat-alarm.ts --send --confirm-send

Detects stale COO heartbeat state without using the Paperclip API or agent adapter path.
Primary source: /Users/openclaw/.paperclip/coo-heartbeat.log mtime.
Fallback source: /Users/openclaw/.paperclip/coo-state.json last_run_at.
Optional corroboration: direct heartbeat_runs DB query.

Options:
  --dry-run                         Print detection and sample redacted alarm. Default.
  --send                            Send Telegram/P0 alert when stale.
  --confirm-send                    Required with --send.
  --state-file PATH                 Default: /Users/openclaw/.paperclip/coo-state.json.
  --heartbeat-log-file PATH         Default: /Users/openclaw/.paperclip/coo-heartbeat.log.
  --dedupe-state-file PATH          Default: .paperclip/coo-heartbeat-alarm-state.json.
  --threshold-minutes N             Default: 90.
  --cooldown-minutes N              Deprecated no-op; escalation state now controls dedupe.
  --skip-db                         Do not query heartbeat_runs.
  --simulate-heartbeat-runs-json P  Read heartbeat_runs snapshots from JSON instead of DB.
  --now ISO                         Test clock override.
  --issue-id ID                     Alert context.
  --issue-identifier KEY            Alert context, e.g. VER-448.
  --issue-title TITLE               Alert context.
  --help                            Show this text.

Exit codes:
  0: heartbeat fresh, or stale alert sent
  2: stale heartbeat detected in dry-run mode
  4: send requested but alert channel is not configured`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: true,
    send: false,
    confirmSend: false,
    skipDb: false,
    help: false,
    stateFile: "/Users/openclaw/.paperclip/coo-state.json",
    heartbeatLogFile: "/Users/openclaw/.paperclip/coo-heartbeat.log",
    dedupeStateFile: path.resolve(process.cwd(), ".paperclip/coo-heartbeat-alarm-state.json"),
    thresholdMinutes: DEFAULT_COO_HEARTBEAT_THRESHOLD_MS / 60_000,
    now: new Date(),
    simulateHeartbeatRunsJson: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run":
        args.dryRun = true;
        args.send = false;
        break;
      case "--send":
        args.send = true;
        args.dryRun = false;
        break;
      case "--confirm-send":
        args.confirmSend = true;
        break;
      case "--skip-db":
        args.skipDb = true;
        break;
      case "--state-file":
        args.stateFile = path.resolve(requireValue(argv[++i], arg));
        break;
      case "--heartbeat-log-file":
        args.heartbeatLogFile = path.resolve(requireValue(argv[++i], arg));
        break;
      case "--dedupe-state-file":
        args.dedupeStateFile = path.resolve(requireValue(argv[++i], arg));
        break;
      case "--threshold-minutes":
        args.thresholdMinutes = positiveInt(requireValue(argv[++i], arg), arg);
        break;
      case "--cooldown-minutes":
        positiveInt(requireValue(argv[++i], arg), arg);
        break;
      case "--simulate-heartbeat-runs-json":
        args.simulateHeartbeatRunsJson = path.resolve(requireValue(argv[++i], arg));
        break;
      case "--now":
        args.now = parseDate(requireValue(argv[++i], arg), arg);
        break;
      case "--issue-id":
        args.issueId = requireValue(argv[++i], arg);
        break;
      case "--issue-identifier":
        args.issueIdentifier = requireValue(argv[++i], arg);
        break;
      case "--issue-title":
        args.issueTitle = requireValue(argv[++i], arg);
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

function readStateFile(file: string) {
  try {
    return parseCooHeartbeatState(JSON.parse(readFileSync(file, "utf8")), file);
  } catch {
    return parseCooHeartbeatState({}, file);
  }
}

function readHeartbeatLog(file: string): CooHeartbeatLogSnapshot {
  try {
    return {
      mtimeAt: statSync(file).mtime,
      source: file,
      exists: true,
    };
  } catch {
    return {
      mtimeAt: null,
      source: file,
      exists: false,
    };
  }
}

async function readHeartbeatRuns(args: Args): Promise<HeartbeatRunSnapshot[]> {
  if (args.skipDb) return [];
  if (args.simulateHeartbeatRunsJson) {
    const raw = JSON.parse(readFileSync(args.simulateHeartbeatRunsJson, "utf8"));
    return (Array.isArray(raw) ? raw : [raw]).map(normalizeRun);
  }

  const target = resolveDatabaseTarget();
  const connectionString = target.mode === "postgres"
    ? target.connectionString
    : `postgres://paperclip:paperclip@127.0.0.1:${target.port}/paperclip`;
  const dbRequire = createRequire(new URL("../packages/db/package.json", import.meta.url));
  const postgres = dbRequire("postgres");
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`
      SELECT
        id,
        status,
        started_at,
        finished_at,
        updated_at,
        created_at,
        agent_id,
        company_id,
        invocation_source
      FROM heartbeat_runs
      WHERE status = 'succeeded'
      ORDER BY COALESCE(finished_at, updated_at, started_at, created_at) DESC
      LIMIT 20
    `;
    return (rows as Record<string, unknown>[]).map(normalizeRun);
  } finally {
    await sql.end();
  }
}

function normalizeRun(row: Record<string, unknown>): HeartbeatRunSnapshot {
  return {
    id: String(row.id ?? "unknown-run"),
    status: String(row.status ?? ""),
    startedAt: parseNullableDate(row.started_at ?? row.startedAt),
    finishedAt: parseNullableDate(row.finished_at ?? row.finishedAt),
    updatedAt: parseNullableDate(row.updated_at ?? row.updatedAt),
    createdAt: parseNullableDate(row.created_at ?? row.createdAt) ?? new Date(0),
    agentId: typeof row.agent_id === "string" ? row.agent_id : typeof row.agentId === "string" ? row.agentId : null,
    companyId: typeof row.company_id === "string" ? row.company_id : typeof row.companyId === "string" ? row.companyId : null,
    invocationSource: typeof row.invocation_source === "string" ? row.invocation_source : typeof row.invocationSource === "string" ? row.invocationSource : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (args.send && !args.confirmSend) {
    throw new Error("--send requires --confirm-send");
  }

  const state = readStateFile(args.stateFile);
  const heartbeatLog = readHeartbeatLog(args.heartbeatLogFile);
  const heartbeatRuns = await readHeartbeatRuns(args);
  const alarm = evaluateCooHeartbeatAlarm({
    now: args.now,
    thresholdMs: args.thresholdMinutes * 60_000,
    heartbeatLog,
    state,
    heartbeatRuns,
  });

  console.log(alarm.reason);
  if (!alarm.stale) return;

  const body = formatCooHeartbeatAlarmBody(alarm);
  const dedupeKey = "coo-heartbeat:stale";
  const message = formatP0AlertMessage({
    dedupeKey,
    title: "COO heartbeat dead",
    operatorAction: "Investigate scheduled-task runner and OAuth/session freshness before resuming normal COO heartbeat actions.",
    body,
    context: {
      issueId: args.issueId,
      issueIdentifier: args.issueIdentifier,
      issueTitle: args.issueTitle,
    },
  }, { escalated: false });

  console.log("\nSample redacted alarm:\n");
  console.log(message);

  if (args.dryRun) {
    process.exitCode = 2;
    return;
  }

  const alertConfig = {
    ...loadP0AlertConfigFromEnv(),
    stateFilePath: args.dedupeStateFile,
  };
  const service = new P0AlertService({
    config: alertConfig,
    now: () => args.now.getTime(),
  });
  const result = await service.alert({
    dedupeKey,
    title: "COO heartbeat dead",
    operatorAction: "Investigate scheduled-task runner and OAuth/session freshness before resuming normal COO heartbeat actions.",
    body,
    context: {
      issueId: args.issueId,
      issueIdentifier: args.issueIdentifier,
      issueTitle: args.issueTitle,
    },
  });

  if (result.outcome === "not_configured") {
    console.error("P0 alert channel is not configured; set PAPERCLIP_P0_TELEGRAM_BOT_TOKEN and PAPERCLIP_P0_TELEGRAM_CHAT_ID.");
    process.exitCode = 4;
    return;
  }

  console.log(`Alert ${result.outcome}: ${result.deliveries.map((delivery) => delivery.channel).join(", ") || "none"}`);
}

function requireValue(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function positiveInt(value: string, name: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseDate(value: string, name: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${name} must be an ISO date`);
  return parsed;
}

function parseNullableDate(value: unknown): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
