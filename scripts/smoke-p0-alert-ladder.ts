#!/usr/bin/env -S pnpm exec tsx
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { P0AlertService, loadP0AlertConfigFromEnv } from "../server/src/services/p0-alerts.ts";

const stateFile = path.join(await mkdtemp(path.join(os.tmpdir(), "paperclip-p0-smoke-")), "state.json");
let now = Date.parse("2026-05-03T12:00:00.000Z");
const deliveries: Array<{ n: number; url: string; body: string }> = [];

const fetchMock: typeof fetch = async (url, init) => {
  deliveries.push({
    n: deliveries.length + 1,
    url: String(url),
    body: String(init?.body ?? ""),
  });
  return new Response("{}", { status: 200 });
};

const config = {
  ...loadP0AlertConfigFromEnv({
    PAPERCLIP_P0_TELEGRAM_BOT_TOKEN: "smoke-telegram-token",
    PAPERCLIP_P0_TELEGRAM_CHAT_ID: "smoke-chat",
    PAPERCLIP_P0_PUSHOVER_APP_TOKEN: "smoke-pushover-token",
    PAPERCLIP_P0_PUSHOVER_USER_KEY: "smoke-pushover-user",
    PAPERCLIP_P0_ALERT_STATE_FILE: stateFile,
  } as NodeJS.ProcessEnv),
  stateFilePath: stateFile,
};

const service = new P0AlertService({
  config,
  fetch: fetchMock,
  now: () => now,
});

const input = {
  dedupeKey: "smoke:coo-heartbeat-dead",
  title: "COO heartbeat dead",
  operatorAction: "Investigate scheduled-task runner and OAuth/session freshness before resuming normal COO heartbeat actions.",
  body: "Smoke test: six identical P0 fires against one stable alarm hash.",
};

const outcomes = [];
for (let i = 0; i < 6; i += 1) {
  outcomes.push(await service.alert(input));
  now += 60_000;
}

console.log("P0 alert ladder smoke");
console.log(`stateFile=${stateFile}`);
outcomes.forEach((result, index) => {
  const channels = result.deliveries.map((delivery) => delivery.channel).join(",") || "none";
  console.log(`#${index + 1}: outcome=${result.outcome} channels=${channels}`);
});
deliveries.forEach((delivery) => {
  const channel = delivery.url.includes("api.telegram.org")
    ? "telegram"
    : delivery.url.includes("api.pushover.net")
      ? "pushover"
      : "webhook";
  console.log(`delivery#${delivery.n}: channel=${channel} url=${redact(delivery.url)} body=${summarize(delivery.body)}`);
});

function redact(value: string): string {
  return value.replace(/botsmoke-telegram-token/g, "bot<redacted>");
}

function summarize(value: string): string {
  const decoded = value.startsWith("{")
    ? JSON.parse(value).text ?? value
    : decodeURIComponent(value);
  return String(decoded).replace(/\s+/g, " ").slice(0, 180);
}
