export const DEFAULT_COO_HEARTBEAT_THRESHOLD_MS = 90 * 60 * 1000;

export interface CooHeartbeatStateSnapshot {
  lastRunAt: Date | null;
  source: string;
}

export interface CooHeartbeatLogSnapshot {
  mtimeAt: Date | null;
  source: string;
  exists: boolean;
}

export interface HeartbeatRunSnapshot {
  id: string;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date | null;
  createdAt: Date;
  agentId?: string | null;
  companyId?: string | null;
  invocationSource?: string | null;
}

export interface CooHeartbeatAlarmInput {
  now: Date;
  thresholdMs?: number;
  heartbeatLog?: CooHeartbeatLogSnapshot | null;
  state: CooHeartbeatStateSnapshot | null;
  heartbeatRuns?: HeartbeatRunSnapshot[];
}

export interface CooHeartbeatAlarm {
  stale: boolean;
  thresholdMs: number;
  lastSuccessfulRunAt: Date | null;
  gapMs: number | null;
  source: string;
  heartbeatLog: CooHeartbeatLogSnapshot | null;
  dbLatestSucceededRun: HeartbeatRunSnapshot | null;
  reason: string;
}

export function parseCooHeartbeatState(raw: unknown, source = "coo-state.json"): CooHeartbeatStateSnapshot {
  const object = asObject(raw);
  const value = object?.last_run_at ?? object?.lastRunAt ?? object?.lastSuccessfulRunAt;
  const parsed = typeof value === "string" ? new Date(value) : null;
  return {
    lastRunAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
    source,
  };
}

export function evaluateCooHeartbeatAlarm(input: CooHeartbeatAlarmInput): CooHeartbeatAlarm {
  const thresholdMs = input.thresholdMs ?? DEFAULT_COO_HEARTBEAT_THRESHOLD_MS;
  const dbLatestSucceededRun = newestSucceededHeartbeatRun(input.heartbeatRuns ?? []);
  const heartbeatLog = input.heartbeatLog ?? null;
  const lastSuccessfulRunAt = heartbeatLog?.mtimeAt ?? input.state?.lastRunAt ?? heartbeatRunTime(dbLatestSucceededRun);
  const source = heartbeatLog?.mtimeAt
    ? heartbeatLog.source
    : input.state?.lastRunAt
      ? input.state.source
      : dbLatestSucceededRun
        ? "heartbeat_runs"
        : heartbeatLog?.source ?? input.state?.source ?? "unknown";

  if (!lastSuccessfulRunAt) {
    return {
      stale: true,
      thresholdMs,
      lastSuccessfulRunAt: null,
      gapMs: null,
      source,
      heartbeatLog,
      dbLatestSucceededRun,
      reason: heartbeatLog && !heartbeatLog.exists
        ? `COO heartbeat log missing: ${heartbeatLog.source}.`
        : "No successful COO heartbeat timestamp found.",
    };
  }

  const gapMs = input.now.getTime() - lastSuccessfulRunAt.getTime();
  const stale = gapMs > thresholdMs;
  return {
    stale,
    thresholdMs,
    lastSuccessfulRunAt,
    gapMs,
    source,
    heartbeatLog,
    dbLatestSucceededRun,
    reason: stale
      ? `COO heartbeat stale for ${formatDuration(gapMs)}; threshold is ${formatDuration(thresholdMs)}.`
      : `COO heartbeat fresh; gap is ${formatDuration(Math.max(0, gapMs))}.`,
  };
}

export function formatCooHeartbeatAlarmBody(alarm: CooHeartbeatAlarm): string {
  const lines = [
    `Gap duration: ${alarm.gapMs === null ? "unknown" : formatDuration(alarm.gapMs)}`,
    `Last COO heartbeat log write: ${alarm.lastSuccessfulRunAt?.toISOString() ?? "unknown"}`,
    `Threshold: ${formatDuration(alarm.thresholdMs)}`,
    `Primary data source: ${alarm.source}`,
  ];

  if (alarm.heartbeatLog) {
    lines.push(`Heartbeat log exists: ${alarm.heartbeatLog.exists ? "yes" : "no"}`);
  }

  if (alarm.dbLatestSucceededRun) {
    lines.push(
      `Latest heartbeat_runs success: ${heartbeatRunTime(alarm.dbLatestSucceededRun)?.toISOString() ?? "unknown"} (${alarm.dbLatestSucceededRun.id})`,
    );
  }

  lines.push(
    "",
    "Operator action: investigate scheduled-task runner and OAuth/session freshness before resuming normal COO heartbeat actions. Do not restart services blindly from this alarm.",
  );

  return lines.join("\n");
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

export function newestSucceededHeartbeatRun(runs: HeartbeatRunSnapshot[]): HeartbeatRunSnapshot | null {
  return runs
    .filter((run) => run.status === "succeeded")
    .sort((a, b) => (heartbeatRunTime(b)?.getTime() ?? 0) - (heartbeatRunTime(a)?.getTime() ?? 0))[0] ?? null;
}

export function heartbeatRunTime(run: HeartbeatRunSnapshot | null): Date | null {
  return run?.finishedAt ?? run?.updatedAt ?? run?.startedAt ?? run?.createdAt ?? null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
