import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  enforceAgentErrorStateHoldTtl,
  SKIP_UNTIL_ALL_MAX_TTL_MS,
} from "../services/agent-error-state-holds.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent error-state hold tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent error-state skip_until.ALL TTL", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-error-state-holds-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentWithHold(input: {
    now: Date;
    appliedAt: Date;
    until: Date;
    reason?: string;
    status?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: input.status ?? "error",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "codex_local",
      lastError: input.reason ?? "adapter_failed",
      stateJson: {
        skip_until: {
          ALL: {
            until: input.until.toISOString(),
            reason: input.reason ?? "adapter_failed",
            appliedAt: input.appliedAt.toISOString(),
          },
        },
      },
      updatedAt: input.appliedAt,
      createdAt: input.appliedAt,
    });
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
    return { companyId, agentId, agent };
  }

  async function seedAgentWithScalarHold(input: {
    runtimeUpdatedAt: Date;
    until: Date;
    reason?: string;
    status?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: input.status ?? "error",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "codex_local",
      lastError: input.reason ?? "adapter_failed",
      stateJson: {
        skip_until: {
          ALL: input.until.toISOString(),
        },
        error_reason: input.reason ?? "adapter_failed",
      },
      updatedAt: input.runtimeUpdatedAt,
      createdAt: input.runtimeUpdatedAt,
    });
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
    return { companyId, agentId, agent };
  }

  it("keeps an under-24h hold active and emits applied evidence once", async () => {
    const now = new Date("2026-05-03T12:00:00.000Z");
    const appliedAt = new Date("2026-05-03T11:00:00.000Z");
    const until = new Date("2026-05-03T14:00:00.000Z");
    const { agentId, agent } = await seedAgentWithHold({ now, appliedAt, until, reason: "weekly cap" });

    const result = await enforceAgentErrorStateHoldTtl(db, agent, { now });

    expect(result).toMatchObject({
      state: "active",
      capped: false,
      reason: "weekly cap",
    });
    if (result.state !== "active") return;
    expect(result.expiresAt.toISOString()).toBe(until.toISOString());

    const runtime = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0]!);
    expect((runtime.stateJson.skip_until as Record<string, unknown>).ALL).toMatchObject({
      until: until.toISOString(),
    });

    const events = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.agentId, agentId), eq(activityLog.action, "agent.error_state_hold_applied")));
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({
      agentName: "CodexCoder",
      holdKey: "skip_until.ALL",
      reason: "weekly cap",
      appliedAt: appliedAt.toISOString(),
      expiresAt: until.toISOString(),
      capped: false,
    });

    await enforceAgentErrorStateHoldTtl(db, agent, { now: new Date("2026-05-03T12:05:00.000Z") });
    const repeatedEvents = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.agentId, agentId), eq(activityLog.action, "agent.error_state_hold_applied")));
    expect(repeatedEvents).toHaveLength(1);
  });

  it("caps future holds at 24h from applied time and reports the capped expiry", async () => {
    const now = new Date("2026-05-03T12:00:00.000Z");
    const appliedAt = new Date("2026-05-03T11:00:00.000Z");
    const requestedUntil = new Date("2026-05-10T11:00:00.000Z");
    const expectedExpiry = new Date(appliedAt.getTime() + SKIP_UNTIL_ALL_MAX_TTL_MS);
    const { agentId, agent } = await seedAgentWithHold({ now, appliedAt, until: requestedUntil });

    const result = await enforceAgentErrorStateHoldTtl(db, agent, { now });

    expect(result).toMatchObject({ state: "active", capped: true });
    if (result.state !== "active") return;
    expect(result.expiresAt.toISOString()).toBe(expectedExpiry.toISOString());

    const runtime = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0]!);
    expect((runtime.stateJson.skip_until as { ALL: { until: string } }).ALL.until).toBe(expectedExpiry.toISOString());
    expect(runtime.stateJson._paperclipSkipUntilAllTtl).toMatchObject({
      expiresAt: expectedExpiry.toISOString(),
      capped: true,
    });
  });

  it("auto-clears holds older than the 24h TTL and moves error agents back to idle", async () => {
    const now = new Date("2026-05-03T12:00:00.000Z");
    const appliedAt = new Date(now.getTime() - SKIP_UNTIL_ALL_MAX_TTL_MS - 60_000);
    const requestedUntil = new Date("2026-05-10T11:00:00.000Z");
    const expectedExpiry = new Date(appliedAt.getTime() + SKIP_UNTIL_ALL_MAX_TTL_MS);
    const { agentId, agent } = await seedAgentWithHold({
      now,
      appliedAt,
      until: requestedUntil,
      reason: "adapter_failed",
      status: "error",
    });

    const result = await enforceAgentErrorStateHoldTtl(db, agent, { now });

    expect(result).toMatchObject({ state: "expired", capped: true });
    if (result.state !== "expired") return;
    expect(result.expiredAt.toISOString()).toBe(expectedExpiry.toISOString());
    expect(result.clearedAt.toISOString()).toBe(now.toISOString());

    const runtime = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0]!);
    expect(runtime.stateJson.skip_until).toBeUndefined();
    expect(runtime.lastError).toBeNull();

    const updatedAgent = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
    expect(updatedAgent.status).toBe("idle");

    const events = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.agentId, agentId), eq(activityLog.action, "agent.error_state_hold_auto_cleared")));
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({
      agentName: "CodexCoder",
      holdKey: "skip_until.ALL",
      reason: "adapter_failed",
      appliedAt: appliedAt.toISOString(),
      expiresAt: expectedExpiry.toISOString(),
      capped: true,
    });
  });

  it("does not slide scalar hold expiry after TTL metadata has been written", async () => {
    const firstObservedAt = new Date("2026-05-03T12:00:00.000Z");
    const appliedAt = new Date("2026-05-03T11:00:00.000Z");
    const requestedUntil = new Date("2026-05-10T11:00:00.000Z");
    const expectedExpiry = new Date(appliedAt.getTime() + SKIP_UNTIL_ALL_MAX_TTL_MS);
    const { agentId, agent } = await seedAgentWithScalarHold({
      runtimeUpdatedAt: appliedAt,
      until: requestedUntil,
      reason: "adapter_failed",
      status: "error",
    });

    const firstResult = await enforceAgentErrorStateHoldTtl(db, agent, { now: firstObservedAt });

    expect(firstResult).toMatchObject({ state: "active", capped: true });
    if (firstResult.state !== "active") return;
    expect(firstResult.appliedAt.toISOString()).toBe(appliedAt.toISOString());
    expect(firstResult.expiresAt.toISOString()).toBe(expectedExpiry.toISOString());

    const secondObservedAt = new Date("2026-05-04T11:05:00.000Z");
    const secondResult = await enforceAgentErrorStateHoldTtl(db, agent, { now: secondObservedAt });

    expect(secondResult).toMatchObject({ state: "expired", capped: true });
    if (secondResult.state !== "expired") return;
    expect(secondResult.appliedAt.toISOString()).toBe(appliedAt.toISOString());
    expect(secondResult.expiredAt.toISOString()).toBe(expectedExpiry.toISOString());
    expect(secondResult.clearedAt.toISOString()).toBe(secondObservedAt.toISOString());

    const runtime = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0]!);
    expect(runtime.stateJson.skip_until).toBeUndefined();

    const events = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.agentId, agentId), eq(activityLog.action, "agent.error_state_hold_auto_cleared")));
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({
      appliedAt: appliedAt.toISOString(),
      expiresAt: expectedExpiry.toISOString(),
      observedAt: secondObservedAt.toISOString(),
      capped: true,
    });
  });

  it("skips new wakeups while a hold is still active", async () => {
    const now = new Date();
    const appliedAt = new Date(now.getTime() - 60_000);
    const until = new Date(now.getTime() + 60 * 60_000);
    const { agentId } = await seedAgentWithHold({ now, appliedAt, until, status: "active" });

    const wakeup = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
    });

    expect(wakeup).toBeNull();
    const requests = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, "agent_error_state_hold_active")));
    expect(requests).toHaveLength(1);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });
});
