import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authUsers,
  boardApiKeys,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  BOARD_KEY_EXPIRY_DEDUPE_MS,
  createFileBackedBoardKeyDedupeStore,
  findExpiringBoardApiKeys,
  formatBoardKeyExpiryAlert,
  tickBoardKeyExpiry,
  type BoardKeyExpiryAlertSink,
} from "../services/board-key-expiry-alarm.ts";
import type { P0AlertResult } from "../services/p0-alerts.ts";

// ── Pure unit tests (no DB) ────────────────────────────────────────────────

describe("formatBoardKeyExpiryAlert", () => {
  const BASE_KEY = {
    id: "test-key-id",
    name: "CI Deploy Key",
    expiresAt: new Date("2026-05-25T12:00:00Z"),
    hoursRemaining: 120,
  };

  it("includes id, name, expiresAt, hoursRemaining in body", () => {
    const alert = formatBoardKeyExpiryAlert(BASE_KEY);
    expect(alert.body).toContain("test-key-id");
    expect(alert.body).toContain("CI Deploy Key");
    expect(alert.body).toContain("2026-05-25T12:00:00.000Z");
    expect(alert.body).toContain("120");
  });

  it("sets dedupeKey scoped to key id", () => {
    const alert = formatBoardKeyExpiryAlert(BASE_KEY);
    expect(alert.dedupeKey).toBe("board_key_expiry:test-key-id");
  });

  it("title notes hours remaining for future expiry", () => {
    const alert = formatBoardKeyExpiryAlert({ ...BASE_KEY, hoursRemaining: 48 });
    expect(alert.title).toContain("CI Deploy Key");
    expect(alert.title).toContain("expires in");
  });

  it("title marks already-expired keys", () => {
    const alert = formatBoardKeyExpiryAlert({ ...BASE_KEY, hoursRemaining: -2 });
    expect(alert.title).toContain("EXPIRED");
  });
});

describe("tickBoardKeyExpiry dedupe logic (in-memory store)", () => {
  function makeMemoryStore() {
    let state: Record<string, number> = {};
    return {
      load: async () => ({ ...state }),
      save: async (s: Record<string, number>) => { state = { ...s }; },
    };
  }

  function makeSink(outcome: P0AlertResult["outcome"] = "sent"): BoardKeyExpiryAlertSink & { calls: number } {
    const sink = {
      calls: 0,
      alert: vi.fn(async () => ({
        outcome,
        deliveries: [],
        dedupeKey: "",
      }) satisfies P0AlertResult),
    };
    return sink as any;
  }

  const BASE_KEY = {
    id: "aaa",
    name: "CI Key",
    expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    hoursRemaining: 120,
  };

  const fakeDb = {
    select: () => ({ from: () => ({ where: async () => [] }) }),
  } as any;

  it("fires alert on first call and dedupes on second call within 6h window", async () => {
    const store = makeMemoryStore();
    const sink = makeSink("sent");
    const now = new Date("2026-05-18T12:00:00Z");
    const nowMs = now.getTime();

    // Manually seed the store as if keys were already found by the DB query.
    // We test tickBoardKeyExpiry directly by injecting a fake db that returns our fixture.
    const fakeDbWithKey = {
      select: () => ({
        from: () => ({
          where: async () => [
            { id: BASE_KEY.id, name: BASE_KEY.name, expiresAt: BASE_KEY.expiresAt },
          ],
        }),
      }),
    } as any;

    // First tick — should alert
    const r1 = await tickBoardKeyExpiry({
      db: fakeDbWithKey,
      alertSink: sink,
      dedupeStore: store,
      now,
    });
    expect(r1.alerted).toBe(1);
    expect(r1.deduped).toBe(0);
    expect(sink.alert).toHaveBeenCalledTimes(1);

    // Second tick within dedupe window (5 min later) — should dedupe
    const r2 = await tickBoardKeyExpiry({
      db: fakeDbWithKey,
      alertSink: sink,
      dedupeStore: store,
      now: new Date(nowMs + 5 * 60 * 1000),
    });
    expect(r2.alerted).toBe(0);
    expect(r2.deduped).toBe(1);
    expect(sink.alert).toHaveBeenCalledTimes(1); // no additional call

    // Third tick after 6h dedupe window — should alert again
    const r3 = await tickBoardKeyExpiry({
      db: fakeDbWithKey,
      alertSink: sink,
      dedupeStore: store,
      now: new Date(nowMs + BOARD_KEY_EXPIRY_DEDUPE_MS + 1000),
    });
    expect(r3.alerted).toBe(1);
    expect(r3.deduped).toBe(0);
    expect(sink.alert).toHaveBeenCalledTimes(2);
  });

  it("returns checked=0 and fires no alerts when no keys are expiring", async () => {
    const store = makeMemoryStore();
    const sink = makeSink();

    const r = await tickBoardKeyExpiry({
      db: fakeDb,
      alertSink: sink,
      dedupeStore: store,
    });
    expect(r.checked).toBe(0);
    expect(r.alerted).toBe(0);
    expect(sink.alert).not.toHaveBeenCalled();
  });
});

describe("createFileBackedBoardKeyDedupeStore", () => {
  it("round-trips state through disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "board-key-dedupe-"));
    const filePath = path.join(dir, "dedupe.json");
    const store = createFileBackedBoardKeyDedupeStore(filePath);

    await store.save({ "key-1": 1234567890, "key-2": 9876543210 });
    const loaded = await store.load();
    expect(loaded["key-1"]).toBe(1234567890);
    expect(loaded["key-2"]).toBe(9876543210);
  });

  it("returns empty object when file does not exist", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "board-key-dedupe-"));
    const store = createFileBackedBoardKeyDedupeStore(path.join(dir, "nonexistent.json"));
    expect(await store.load()).toEqual({});
  });
});

// ── Integration tests: real Postgres (single shared instance) ─────────────

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres board-key-expiry tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("board-key-expiry-alarm integration (real DB)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let userId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-key-expiry-");
    db = createDb(tempDb.connectionString);

    userId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: "Test User",
      email: `test-${userId}@example.com`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.stop();
  });

  it("returns key expiring in 5 days and computes hoursRemaining correctly", async () => {
    const now = new Date("2026-05-18T12:00:00Z");
    const fiveDaysOut = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

    const keyId = randomUUID();
    await db.insert(boardApiKeys).values({
      id: keyId,
      userId,
      name: "CI Deploy Key",
      keyHash: `hash-${keyId}`,
      expiresAt: fiveDaysOut,
      createdAt: now,
    });

    const results = await findExpiringBoardApiKeys(db as any, now);
    const found = results.find((r) => r.id === keyId);
    expect(found).toBeDefined();
    expect(found?.name).toBe("CI Deploy Key");
    expect(found?.expiresAt.toISOString()).toBe(fiveDaysOut.toISOString());
    // 5 days = 120h; allow small float drift
    expect(found?.hoursRemaining).toBeCloseTo(120, 1);
  });

  it("does not return revoked keys", async () => {
    const now = new Date("2026-05-18T12:00:00Z");
    const fiveDaysOut = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

    const keyId = randomUUID();
    await db.insert(boardApiKeys).values({
      id: keyId,
      userId,
      name: "Revoked Key",
      keyHash: `hash-revoked-${keyId}`,
      expiresAt: fiveDaysOut,
      revokedAt: now,
      createdAt: now,
    });

    const results = await findExpiringBoardApiKeys(db as any, now);
    expect(results.find((r) => r.id === keyId)).toBeUndefined();
  });

  it("does not return keys expiring beyond 7 days", async () => {
    const now = new Date("2026-05-18T12:00:00Z");
    const eightDaysOut = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);

    const keyId = randomUUID();
    await db.insert(boardApiKeys).values({
      id: keyId,
      userId,
      name: "Safe Key",
      keyHash: `hash-safe-${keyId}`,
      expiresAt: eightDaysOut,
      createdAt: now,
    });

    const results = await findExpiringBoardApiKeys(db as any, now);
    expect(results.find((r) => r.id === keyId)).toBeUndefined();
  });

  it("fires P1 alert once for 5-day fixture; does not refire within 6h dedupe window", async () => {
    const now = new Date("2026-05-18T14:00:00Z");
    const fiveDaysOut = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

    const keyId = randomUUID();
    await db.insert(boardApiKeys).values({
      id: keyId,
      userId,
      name: "5-Day Fixture Key",
      keyHash: `hash-5d-${keyId}`,
      expiresAt: fiveDaysOut,
      createdAt: now,
    });

    const alertCalls: Parameters<BoardKeyExpiryAlertSink["alert"]>[0][] = [];
    const sink: BoardKeyExpiryAlertSink = {
      alert: vi.fn(async (input) => {
        alertCalls.push(input);
        return { outcome: "sent" as const, deliveries: [], dedupeKey: input.dedupeKey };
      }),
    };

    const dir = await mkdtemp(path.join(os.tmpdir(), "board-key-e2e-"));
    const dedupeStore = createFileBackedBoardKeyDedupeStore(path.join(dir, "dedupe.json"));

    // First tick — should fire
    const r1 = await tickBoardKeyExpiry({ db: db as any, alertSink: sink, dedupeStore, now });
    expect(r1.alerted).toBe(1);
    expect(r1.deduped).toBe(0);
    expect(alertCalls).toHaveLength(1);
    expect(alertCalls[0]?.dedupeKey).toBe(`board_key_expiry:${keyId}`);
    expect(alertCalls[0]?.body).toContain(keyId);
    expect(alertCalls[0]?.body).toContain("5-Day Fixture Key");
    expect(alertCalls[0]?.body).toContain(fiveDaysOut.toISOString());

    // Second tick 30 min later — must NOT fire (within 6h dedupe)
    const r2 = await tickBoardKeyExpiry({
      db: db as any,
      alertSink: sink,
      dedupeStore,
      now: new Date(now.getTime() + 30 * 60 * 1000),
    });
    expect(r2.alerted).toBe(0);
    expect(r2.deduped).toBe(1);
    expect(alertCalls).toHaveLength(1); // still only 1 call total

    // Third tick 5h 59m later — still within 6h window, must not fire
    const r3 = await tickBoardKeyExpiry({
      db: db as any,
      alertSink: sink,
      dedupeStore,
      now: new Date(now.getTime() + (6 * 60 - 1) * 60 * 1000),
    });
    expect(r3.alerted).toBe(0);
    expect(r3.deduped).toBe(1);
    expect(alertCalls).toHaveLength(1);

    // Fourth tick exactly 6h + 1s later — dedupe expired, should fire again
    const r4 = await tickBoardKeyExpiry({
      db: db as any,
      alertSink: sink,
      dedupeStore,
      now: new Date(now.getTime() + BOARD_KEY_EXPIRY_DEDUPE_MS + 1000),
    });
    expect(r4.alerted).toBe(1);
    expect(r4.deduped).toBe(0);
    expect(alertCalls).toHaveLength(2);
  });
});
