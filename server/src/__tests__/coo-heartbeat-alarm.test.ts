import { describe, expect, it } from "vitest";
import {
  evaluateCooHeartbeatAlarm,
  formatCooHeartbeatAlarmBody,
  parseCooHeartbeatState,
} from "../services/coo-heartbeat-alarm.js";

describe("COO heartbeat alarm", () => {
  it("detects a stale coo-state last_run_at beyond the 90-minute threshold", () => {
    const alarm = evaluateCooHeartbeatAlarm({
      now: new Date("2026-05-03T12:00:00.000Z"),
      state: parseCooHeartbeatState({ last_run_at: "2026-05-03T10:20:00.000Z" }),
    });

    expect(alarm.stale).toBe(true);
    expect(alarm.reason).toContain("1h 40m");
    expect(formatCooHeartbeatAlarmBody(alarm)).toContain("Do not restart services blindly");
  });

  it("uses the COO heartbeat log mtime as the primary freshness signal", () => {
    const alarm = evaluateCooHeartbeatAlarm({
      now: new Date("2026-05-03T12:00:00.000Z"),
      heartbeatLog: {
        mtimeAt: new Date("2026-05-03T09:59:00.000Z"),
        source: "/Users/openclaw/.paperclip/coo-heartbeat.log",
        exists: true,
      },
      state: parseCooHeartbeatState({ last_run_at: "2026-05-03T11:59:00.000Z" }),
    });

    expect(alarm.stale).toBe(true);
    expect(alarm.source).toBe("/Users/openclaw/.paperclip/coo-heartbeat.log");
    expect(alarm.reason).toContain("2h 1m");
    expect(formatCooHeartbeatAlarmBody(alarm)).toContain("Last COO heartbeat log write");
  });

  it("treats a missing COO heartbeat log as stale", () => {
    const alarm = evaluateCooHeartbeatAlarm({
      now: new Date("2026-05-03T12:00:00.000Z"),
      heartbeatLog: {
        mtimeAt: null,
        source: "/Users/openclaw/.paperclip/coo-heartbeat.log",
        exists: false,
      },
      state: parseCooHeartbeatState({}),
    });

    expect(alarm.stale).toBe(true);
    expect(alarm.reason).toContain("log missing");
  });

  it("does not alert before the stale threshold", () => {
    const alarm = evaluateCooHeartbeatAlarm({
      now: new Date("2026-05-03T12:00:00.000Z"),
      state: parseCooHeartbeatState({ last_run_at: "2026-05-03T10:31:00.000Z" }),
    });

    expect(alarm.stale).toBe(false);
    expect(alarm.reason).toContain("1h 29m");
  });

  it("falls back to heartbeat_runs when the state file has no timestamp", () => {
    const alarm = evaluateCooHeartbeatAlarm({
      now: new Date("2026-05-03T12:00:00.000Z"),
      state: parseCooHeartbeatState({}),
      heartbeatRuns: [
        {
          id: "run-old",
          status: "succeeded",
          startedAt: new Date("2026-05-03T09:00:00.000Z"),
          finishedAt: new Date("2026-05-03T09:01:00.000Z"),
          updatedAt: null,
          createdAt: new Date("2026-05-03T09:00:00.000Z"),
        },
      ],
    });

    expect(alarm.stale).toBe(true);
    expect(alarm.source).toBe("heartbeat_runs");
    expect(alarm.dbLatestSucceededRun?.id).toBe("run-old");
  });
});
