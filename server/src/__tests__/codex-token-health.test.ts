import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_TOKEN_REFRESH_THRESHOLD_MS,
  evaluateCodexTokenHealth,
  formatCodexTokenHealthBody,
  parseCodexAuthSnapshot,
} from "../services/codex-token-health.js";

describe("Codex token health", () => {
  it("reports healthy when last_refresh is newer than 12 hours", () => {
    const auth = parseCodexAuthSnapshot(
      JSON.stringify({
        OPENAI_API_KEY: "redacted-test-value",
        tokens: { access_token: "redacted-test-value", refresh_token: "redacted-test-value" },
        last_refresh: "2026-05-04T00:30:00.000Z",
      }),
      "/tmp/auth.json",
    );

    const result = evaluateCodexTokenHealth({
      now: new Date("2026-05-04T02:00:00.000Z"),
      auth,
    });

    expect(result.status).toBe("healthy");
    expect(result.alert).toBe(false);
    expect(result.ageMs).toBe(90 * 60 * 1000);
    expect(formatCodexTokenHealthBody(result)).not.toContain("redacted-test-value");
  });

  it("alerts when last_refresh is older than 12 hours", () => {
    const auth = parseCodexAuthSnapshot(
      JSON.stringify({
        tokens: { access_token: "redacted-test-value", refresh_token: "redacted-test-value" },
        last_refresh: "2026-05-03T10:00:00.000Z",
      }),
      "/tmp/auth.json",
    );

    const result = evaluateCodexTokenHealth({
      now: new Date("2026-05-04T02:01:00.000Z"),
      auth,
    });

    expect(result.status).toBe("stale");
    expect(result.alert).toBe(true);
    expect(result.thresholdMs).toBe(DEFAULT_CODEX_TOKEN_REFRESH_THRESHOLD_MS);
    expect(result.reason).toContain("threshold is 12h");
  });

  it("alerts without leaking secrets when auth JSON is invalid", () => {
    const auth = parseCodexAuthSnapshot("{", "/tmp/auth.json");

    const result = evaluateCodexTokenHealth({
      now: new Date("2026-05-04T02:00:00.000Z"),
      auth,
    });

    expect(result.status).toBe("invalid_auth_json");
    expect(result.alert).toBe(true);
    expect(result.reason).not.toContain("access_token");
  });

  it("alerts when last_refresh is missing", () => {
    const auth = parseCodexAuthSnapshot(
      JSON.stringify({ tokens: { refresh_token: "redacted-test-value" } }),
      "/tmp/auth.json",
    );

    const result = evaluateCodexTokenHealth({
      now: new Date("2026-05-04T02:00:00.000Z"),
      auth,
    });

    expect(result.status).toBe("missing_last_refresh");
    expect(result.alert).toBe(true);
  });
});
