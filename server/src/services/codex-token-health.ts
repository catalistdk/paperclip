import { formatDuration } from "./coo-heartbeat-alarm.js";

export const DEFAULT_CODEX_TOKEN_REFRESH_THRESHOLD_MS = 12 * 60 * 60 * 1000;

export type CodexTokenHealthStatus =
  | "healthy"
  | "stale"
  | "missing_auth_file"
  | "invalid_auth_json"
  | "missing_last_refresh"
  | "future_last_refresh";

export interface CodexTokenAuthSnapshot {
  authFilePath: string;
  exists: boolean;
  rawLastRefresh: string | null;
  lastRefreshAt: Date | null;
  parseError?: string | null;
}

export interface CodexTokenHealthInput {
  now: Date;
  thresholdMs?: number;
  auth: CodexTokenAuthSnapshot;
}

export interface CodexTokenHealthResult {
  status: CodexTokenHealthStatus;
  alert: boolean;
  thresholdMs: number;
  authFilePath: string;
  lastRefreshAt: Date | null;
  ageMs: number | null;
  reason: string;
}

export function parseCodexAuthSnapshot(raw: string | null, authFilePath: string): CodexTokenAuthSnapshot {
  if (raw === null) {
    return {
      authFilePath,
      exists: false,
      rawLastRefresh: null,
      lastRefreshAt: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      authFilePath,
      exists: true,
      rawLastRefresh: null,
      lastRefreshAt: null,
      parseError: error instanceof Error ? error.message : "Invalid JSON",
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      authFilePath,
      exists: true,
      rawLastRefresh: null,
      lastRefreshAt: null,
      parseError: "Expected top-level JSON object",
    };
  }

  const rawLastRefresh = (parsed as Record<string, unknown>).last_refresh;
  const lastRefreshText = typeof rawLastRefresh === "string" && rawLastRefresh.trim().length > 0
    ? rawLastRefresh.trim()
    : null;
  const lastRefreshAt = lastRefreshText ? new Date(lastRefreshText) : null;

  return {
    authFilePath,
    exists: true,
    rawLastRefresh: lastRefreshText,
    lastRefreshAt: lastRefreshAt && !Number.isNaN(lastRefreshAt.getTime()) ? lastRefreshAt : null,
    parseError: lastRefreshText && (!lastRefreshAt || Number.isNaN(lastRefreshAt.getTime()))
      ? "Invalid last_refresh timestamp"
      : null,
  };
}

export function evaluateCodexTokenHealth(input: CodexTokenHealthInput): CodexTokenHealthResult {
  const thresholdMs = input.thresholdMs ?? DEFAULT_CODEX_TOKEN_REFRESH_THRESHOLD_MS;
  const authFilePath = input.auth.authFilePath;

  if (!input.auth.exists) {
    return {
      status: "missing_auth_file",
      alert: true,
      thresholdMs,
      authFilePath,
      lastRefreshAt: null,
      ageMs: null,
      reason: `Codex auth file missing: ${authFilePath}.`,
    };
  }

  if (input.auth.parseError && !input.auth.rawLastRefresh) {
    return {
      status: "invalid_auth_json",
      alert: true,
      thresholdMs,
      authFilePath,
      lastRefreshAt: null,
      ageMs: null,
      reason: `Codex auth file is not parseable enough to read last_refresh: ${input.auth.parseError}.`,
    };
  }

  if (!input.auth.rawLastRefresh) {
    return {
      status: "missing_last_refresh",
      alert: true,
      thresholdMs,
      authFilePath,
      lastRefreshAt: null,
      ageMs: null,
      reason: "Codex auth file has no last_refresh timestamp.",
    };
  }

  if (!input.auth.lastRefreshAt) {
    return {
      status: "invalid_auth_json",
      alert: true,
      thresholdMs,
      authFilePath,
      lastRefreshAt: null,
      ageMs: null,
      reason: `Codex auth last_refresh is invalid: ${input.auth.parseError ?? "unparseable timestamp"}.`,
    };
  }

  const ageMs = input.now.getTime() - input.auth.lastRefreshAt.getTime();
  if (ageMs < 0) {
    return {
      status: "future_last_refresh",
      alert: true,
      thresholdMs,
      authFilePath,
      lastRefreshAt: input.auth.lastRefreshAt,
      ageMs,
      reason: `Codex auth last_refresh is in the future by ${formatDuration(Math.abs(ageMs))}.`,
    };
  }

  const stale = ageMs > thresholdMs;
  return {
    status: stale ? "stale" : "healthy",
    alert: stale,
    thresholdMs,
    authFilePath,
    lastRefreshAt: input.auth.lastRefreshAt,
    ageMs,
    reason: stale
      ? `Codex token refresh is stale for ${formatDuration(ageMs)}; threshold is ${formatDuration(thresholdMs)}.`
      : `Codex token refresh is healthy; age is ${formatDuration(ageMs)}.`,
  };
}

export function formatCodexTokenHealthBody(result: CodexTokenHealthResult): string {
  return [
    `Status: ${result.status}`,
    `Auth file: ${result.authFilePath}`,
    `Last refresh: ${result.lastRefreshAt?.toISOString() ?? "unknown"}`,
    `Refresh age: ${result.ageMs === null ? "unknown" : formatDuration(Math.abs(result.ageMs))}`,
    `Threshold: ${formatDuration(result.thresholdMs)}`,
    "",
    "Operator action: refresh Codex local auth before waking more Codex agents. Do not paste or attach auth.json; this monitor intentionally reports only timestamp metadata.",
  ].join("\n");
}
