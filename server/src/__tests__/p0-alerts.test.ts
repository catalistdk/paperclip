import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { P0AlertService, formatP0AlertMessage } from "../services/p0-alerts.js";

function config(stateFilePath: string) {
  return {
    telegramBotToken: "telegram-token",
    telegramChatId: "telegram-chat",
    pushoverAppToken: "pushover-token",
    pushoverUserKey: "pushover-user",
    stateFilePath,
    firstWindowMs: 60 * 60 * 1000,
    urgentWindowMs: 4 * 60 * 60 * 1000,
    fallbackWindowMs: 24 * 60 * 60 * 1000,
    dedupeTtlMs: 24 * 60 * 60 * 1000,
  };
}

function input() {
  return {
    dedupeKey: "alarm:stable-hash",
    title: "COO heartbeat dead",
    operatorAction: "Wake Rasmus and inspect runner health.",
    body: "No COO heartbeat has landed inside the threshold.",
  };
}

describe("P0AlertService", () => {
  it("escalates repeated identical P0 alarms through standard, urgent, and Pushover fallback", async () => {
    const stateFile = path.join(await mkdtemp(path.join(os.tmpdir(), "p0-alerts-")), "state.json");
    let now = Date.parse("2026-05-03T12:00:00.000Z");
    const fetchMock = vi.fn(async () => new Response("{}"));
    const service = new P0AlertService({
      config: config(stateFile),
      fetch: fetchMock,
      now: () => now,
    });

    const outcomes = [];
    for (let i = 0; i < 6; i += 1) {
      outcomes.push(await service.alert(input()));
      now += 60_000;
    }

    expect(outcomes.map((result) => result.outcome)).toEqual([
      "sent",
      "deduped",
      "escalated",
      "deduped",
      "escalated",
      "deduped",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const telegramBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("api.telegram.org"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)).text as string);
    expect(telegramBodies[0]).toContain("P0 EMERGENCY");
    expect(telegramBodies[1]).toContain("🚨🚨 *P0 ESCALATION: repeated identical alarm*");

    const pushoverCall = fetchMock.mock.calls.find(([url]) => String(url).includes("api.pushover.net"));
    expect(pushoverCall).toBeTruthy();
    expect(String((pushoverCall?.[1] as RequestInit).body)).toContain("priority=2");
  });

  it("resets counters when the alarm hash resolves", async () => {
    const stateFile = path.join(await mkdtemp(path.join(os.tmpdir(), "p0-alerts-")), "state.json");
    let now = Date.parse("2026-05-03T12:00:00.000Z");
    const fetchMock = vi.fn(async () => new Response("{}"));
    const service = new P0AlertService({
      config: config(stateFile),
      fetch: fetchMock,
      now: () => now,
    });

    await service.alert(input());
    await service.alert(input());
    expect(await service.resolve(input().dedupeKey)).toBe(true);
    now += 60_000;
    const afterResolve = await service.alert(input());

    expect(afterResolve.outcome).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("loads hash counters from disk after process restart", async () => {
    const stateFile = path.join(await mkdtemp(path.join(os.tmpdir(), "p0-alerts-")), "state.json");
    let now = Date.parse("2026-05-03T12:00:00.000Z");
    const firstFetch = vi.fn(async () => new Response("{}"));
    const firstService = new P0AlertService({
      config: config(stateFile),
      fetch: firstFetch,
      now: () => now,
    });
    await firstService.alert(input());
    await firstService.alert(input());

    now += 60_000;
    const secondFetch = vi.fn(async () => new Response("{}"));
    const restartedService = new P0AlertService({
      config: config(stateFile),
      fetch: secondFetch,
      now: () => now,
    });
    const result = await restartedService.alert(input());

    expect(result.outcome).toBe("escalated");
    expect(secondFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((secondFetch.mock.calls[0]?.[1] as RequestInit).body)).text as string;
    expect(body).toContain("repeated identical alarm");

    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    expect(persisted.states[input().dedupeKey].seenAt).toHaveLength(3);
  });

  it("uses a documented stub fallback when no phone-capable credentials are configured", async () => {
    const stateFile = path.join(await mkdtemp(path.join(os.tmpdir(), "p0-alerts-")), "state.json");
    let now = Date.parse("2026-05-03T12:00:00.000Z");
    const fetchMock = vi.fn(async () => new Response("{}"));
    const service = new P0AlertService({
      config: { ...config(stateFile), pushoverAppToken: undefined, pushoverUserKey: undefined },
      fetch: fetchMock,
      now: () => now,
    });

    let result = await service.alert(input());
    for (let i = 0; i < 4; i += 1) {
      now += 60_000;
      result = await service.alert(input());
    }

    expect(result.outcome).toBe("escalated");
    expect(result.deliveries).toEqual([{ channel: "stub", escalated: true }]);
  });

  it("formats escalation text explicitly for Telegram", () => {
    const message = formatP0AlertMessage(input(), { tier: "urgent" });
    expect(message).toContain("🚨🚨 *P0 ESCALATION: repeated identical alarm*");
    expect(message).toContain("Action: Wake Rasmus and inspect runner health.");
    expect(message).toContain("Dedupe: alarm:stable-hash");
  });
});
