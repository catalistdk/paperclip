import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, agentRuntimeState } from "@paperclipai/db";

export const SKIP_UNTIL_ALL_MAX_TTL_MS = 24 * 60 * 60 * 1000;

type AgentRow = typeof agents.$inferSelect;

export type AgentErrorStateHoldResult =
  | { state: "none" }
  | {
      state: "active";
      reason: string | null;
      appliedAt: Date;
      expiresAt: Date;
      capped: boolean;
    }
  | {
      state: "expired";
      reason: string | null;
      appliedAt: Date;
      expiredAt: Date;
      clearedAt: Date;
      capped: boolean;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return null;
}

function parseDateValue(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const parsed = new Date(millis);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  const text = readString(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function readHoldUntil(value: unknown): Date | null {
  if (!isRecord(value)) return parseDateValue(value);
  return parseDateValue(
    value.until ??
      value.expiresAt ??
      value.expires_at ??
      value.skipUntil ??
      value.skip_until,
  );
}

function readHoldReason(value: unknown, stateJson: Record<string, unknown>, fallback: string | null): string | null {
  if (isRecord(value)) {
    return readString(value.reason) ?? readString(value.error) ?? fallback;
  }
  return readString(stateJson.error_reason) ??
    readString(stateJson.errorReason) ??
    readString(stateJson.reason) ??
    fallback;
}

function readAppliedAt(
  value: unknown,
  stateJson: Record<string, unknown>,
  runtimeUpdatedAt: Date,
): Date {
  const fromValue = isRecord(value)
    ? parseDateValue(value.appliedAt ?? value.applied_at ?? value.createdAt ?? value.created_at)
    : null;
  if (fromValue) return fromValue;

  const appliedByKey = isRecord(stateJson.skip_until_applied_at)
    ? parseDateValue(stateJson.skip_until_applied_at.ALL)
    : null;
  const ttlMetaAppliedAt = isRecord(stateJson._paperclipSkipUntilAllTtl)
    ? parseDateValue(stateJson._paperclipSkipUntilAllTtl.appliedAt)
    : null;
  return appliedByKey ?? parseDateValue(stateJson.skipUntilAllAppliedAt) ?? ttlMetaAppliedAt ?? runtimeUpdatedAt;
}

function setHoldUntil(value: unknown, expiresAt: Date): unknown {
  if (!isRecord(value)) return expiresAt.toISOString();
  const next = { ...value };
  if ("until" in next) next.until = expiresAt.toISOString();
  else if ("expiresAt" in next) next.expiresAt = expiresAt.toISOString();
  else if ("expires_at" in next) next.expires_at = expiresAt.toISOString();
  else if ("skipUntil" in next) next.skipUntil = expiresAt.toISOString();
  else if ("skip_until" in next) next.skip_until = expiresAt.toISOString();
  else next.until = expiresAt.toISOString();
  return next;
}

function readTtlMeta(stateJson: Record<string, unknown>): Record<string, unknown> {
  return isRecord(stateJson._paperclipSkipUntilAllTtl)
    ? { ...stateJson._paperclipSkipUntilAllTtl }
    : {};
}

function buildStateWithHold(
  stateJson: Record<string, unknown>,
  holdValue: unknown,
  expiresAt: Date,
  meta: Record<string, unknown>,
) {
  const skipUntil = isRecord(stateJson.skip_until) ? { ...stateJson.skip_until } : {};
  skipUntil.ALL = setHoldUntil(holdValue, expiresAt);
  return {
    ...stateJson,
    skip_until: skipUntil,
    _paperclipSkipUntilAllTtl: meta,
  };
}

function buildStateWithoutHold(stateJson: Record<string, unknown>) {
  const next = { ...stateJson };
  const skipUntil = isRecord(next.skip_until) ? { ...next.skip_until } : {};
  delete skipUntil.ALL;
  if (Object.keys(skipUntil).length === 0) delete next.skip_until;
  else next.skip_until = skipUntil;
  delete next._paperclipSkipUntilAllTtl;
  return next;
}

async function logHoldEvent(
  db: Db,
  input: {
    action: string;
    agent: AgentRow;
    reason: string | null;
    appliedAt: Date;
    expiresAt: Date;
    observedAt: Date;
    capped: boolean;
  },
) {
  await db.insert(activityLog).values({
    companyId: input.agent.companyId,
    actorType: "system",
    actorId: "system",
    action: input.action,
    entityType: "agent",
    entityId: input.agent.id,
    agentId: input.agent.id,
    details: {
      agentId: input.agent.id,
      agentName: input.agent.name,
      holdKey: "skip_until.ALL",
      reason: input.reason,
      appliedAt: input.appliedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      observedAt: input.observedAt.toISOString(),
      capped: input.capped,
    },
  });
}

export async function enforceAgentErrorStateHoldTtl(
  db: Db,
  agent: AgentRow,
  options?: { now?: Date },
): Promise<AgentErrorStateHoldResult> {
  const now = options?.now ?? new Date();
  const runtime = await db
    .select()
    .from(agentRuntimeState)
    .where(eq(agentRuntimeState.agentId, agent.id))
    .then((rows) => rows[0] ?? null);
  if (!runtime) return { state: "none" };

  const stateJson = isRecord(runtime.stateJson) ? runtime.stateJson : {};
  const skipUntil = isRecord(stateJson.skip_until) ? stateJson.skip_until : null;
  const holdValue = skipUntil?.ALL;
  const requestedUntil = readHoldUntil(holdValue);
  if (!requestedUntil) return { state: "none" };

  const reason = readHoldReason(holdValue, stateJson, runtime.lastError);
  const appliedAt = readAppliedAt(holdValue, stateJson, runtime.updatedAt);
  const maxExpiresAt = new Date(appliedAt.getTime() + SKIP_UNTIL_ALL_MAX_TTL_MS);
  const meta = readTtlMeta(stateJson);
  const capped = requestedUntil.getTime() > maxExpiresAt.getTime() || readBoolean(meta.capped) === true;
  const effectiveExpiresAt = capped ? maxExpiresAt : requestedUntil;
  const metaExpiresAt = readString(meta.expiresAt);
  const metaAppliedAlertedAt = readString(meta.appliedAlertedAt);
  const nextMeta: Record<string, unknown> = {
    ...meta,
    appliedAt: appliedAt.toISOString(),
    expiresAt: effectiveExpiresAt.toISOString(),
    reason,
    capped,
  };

  if (effectiveExpiresAt.getTime() <= now.getTime()) {
    const clearedStateJson = buildStateWithoutHold(stateJson);
    await db
      .update(agentRuntimeState)
      .set({
        stateJson: clearedStateJson,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(agentRuntimeState.agentId, agent.id));
    if (agent.status === "error") {
      await db
        .update(agents)
        .set({ status: "idle", pauseReason: null, updatedAt: now })
        .where(and(eq(agents.id, agent.id), eq(agents.status, "error")));
    }
    await logHoldEvent(db, {
      action: "agent.error_state_hold_auto_cleared",
      agent,
      reason,
      appliedAt,
      expiresAt: effectiveExpiresAt,
      observedAt: now,
      capped,
    });
    return {
      state: "expired",
      reason,
      appliedAt,
      expiredAt: effectiveExpiresAt,
      clearedAt: now,
      capped,
    };
  }

  const needsRuntimeUpdate = capped || metaExpiresAt !== effectiveExpiresAt.toISOString() || !metaAppliedAlertedAt;
  if (needsRuntimeUpdate) {
    nextMeta.appliedAlertedAt = metaAppliedAlertedAt ?? now.toISOString();
    await db
      .update(agentRuntimeState)
      .set({
        stateJson: buildStateWithHold(stateJson, holdValue, effectiveExpiresAt, nextMeta),
        updatedAt: now,
      })
      .where(eq(agentRuntimeState.agentId, agent.id));
  }
  if (!metaAppliedAlertedAt) {
    await logHoldEvent(db, {
      action: "agent.error_state_hold_applied",
      agent,
      reason,
      appliedAt,
      expiresAt: effectiveExpiresAt,
      observedAt: now,
      capped,
    });
  }

  return {
    state: "active",
    reason,
    appliedAt,
    expiresAt: effectiveExpiresAt,
    capped,
  };
}
