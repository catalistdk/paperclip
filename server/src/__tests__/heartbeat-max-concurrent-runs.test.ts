import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

// Peak concurrency tracker — incremented on entry, decremented on exit.
// Each test resets this before firing wakes.
let peakConcurrentExecutions = 0;
let currentConcurrentExecutions = 0;

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => {
    currentConcurrentExecutions += 1;
    if (currentConcurrentExecutions > peakConcurrentExecutions) {
      peakConcurrentExecutions = currentConcurrentExecutions;
    }
    // Yield to event loop so concurrent calls have a chance to overlap.
    await new Promise((resolve) => setTimeout(resolve, 10));
    currentConcurrentExecutions -= 1;
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "maxConcurrentRuns gate test run.",
      provider: "test",
      model: "test-model",
    };
  }),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres maxConcurrentRuns gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat maxConcurrentRuns=1 gate — local adapters", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-max-concurrent-runs-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    peakConcurrentExecutions = 0;
    currentConcurrentExecutions = 0;

    // Wait for all runs to settle before cleaning up.
    for (let attempt = 0; attempt < 200; attempt++) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActive = runs.some((r) => r.status === "queued" || r.status === "running");
      if (!hasActive) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
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

  async function seedAgent(input: {
    companyId: string;
    agentId: string;
    maxConcurrentRuns: number;
    adapterType?: "codex_local" | "claude_local";
  }) {
    const adapterType = input.adapterType ?? "codex_local";
    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: adapterType === "claude_local" ? "ClaudeCoder" : "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: input.maxConcurrentRuns,
        },
      },
      permissions: {},
    });
  }

  for (const adapterType of ["codex_local", "claude_local"] as const) {
    it(`[${adapterType}] 5 burst wakes with maxConcurrentRuns=1 → at most 1 OS subprocess at any moment`, async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      await seedAgent({ companyId, agentId, maxConcurrentRuns: 1, adapterType });

      // Create 5 distinct issues so each wake has a unique task scope and doesn't
      // coalesce into the same queued run.
      const issueIds = Array.from({ length: 5 }, () => randomUUID());
      await db.insert(issues).values(
        issueIds.map((id, i) => ({
          id,
          companyId,
          title: `Burst issue ${i}`,
          status: "todo" as const,
          priority: "medium" as const,
          assigneeAgentId: agentId,
        })),
      );

      // Fire 5 wakes simultaneously — do NOT await individually; let them race.
      const wakePromises = issueIds.map((issueId) =>
        heartbeat.wakeup(agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId },
          contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        }),
      );
      await Promise.all(wakePromises);

      // Wait for all runs to reach a terminal state.
      const allSettled = await waitForCondition(async () => {
        const runs = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(sql`${heartbeatRuns.agentId} = ${agentId}`);
        return (
          runs.length >= 5 &&
          runs.every((r) => r.status !== "queued" && r.status !== "running")
        );
      });
      expect(allSettled).toBe(true);

      // The gate: at no point should more than 1 adapter execute() have been
      // in flight simultaneously.
      expect(peakConcurrentExecutions).toBeLessThanOrEqual(1);

      // All 5 wakes must have produced at least 1 run each (coalescing allowed
      // for same issue, but each distinct issue must get a run).
      const totalRuns = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.agentId} = ${agentId}`)
        .then((rows) => rows[0]?.count ?? 0);
      expect(totalRuns).toBeGreaterThanOrEqual(5);
    }, 30_000);
  }

  it("maxConcurrentRuns=1 enforced even when 10 wakes arrive within the same event-loop tick", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await seedAgent({ companyId, agentId, maxConcurrentRuns: 1 });

    // Create 10 distinct issues so no coalescing occurs.
    const issueIds = Array.from({ length: 10 }, () => randomUUID());
    await db.insert(issues).values(
      issueIds.map((id, i) => ({
        id,
        companyId,
        title: `Tick issue ${i}`,
        status: "todo" as const,
        priority: "medium" as const,
        assigneeAgentId: agentId,
      })),
    );

    // Fire all 10 wakes synchronously before yielding to the event loop.
    const wakePromises = issueIds.map((issueId) =>
      heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      }),
    );
    await Promise.all(wakePromises);

    const allSettled = await waitForCondition(async () => {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.agentId} = ${agentId}`);
      return (
        runs.length >= 10 &&
        runs.every((r) => r.status !== "queued" && r.status !== "running")
      );
    });
    expect(allSettled).toBe(true);
    expect(peakConcurrentExecutions).toBeLessThanOrEqual(1);
  }, 30_000);
});
