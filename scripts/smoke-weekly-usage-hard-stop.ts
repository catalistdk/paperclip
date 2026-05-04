#!/usr/bin/env -S pnpm exec tsx
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { weeklyUsageService } from "../server/src/services/weekly-usage.ts";

function createDbStub(selectRows: unknown[][]) {
  const pendingSelects = [...selectRows];
  const selectOrderBy = async () => pendingSelects.shift() ?? [];
  const selectWhere = () => ({
    orderBy: selectOrderBy,
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(pendingSelects.shift() ?? [])),
  });
  const selectInnerJoin = () => ({
    where: selectWhere,
  });
  const selectFrom = () => ({
    innerJoin: selectInnerJoin,
    where: selectWhere,
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(pendingSelects.shift() ?? [])),
  });
  const select = () => ({
    from: selectFrom,
  });

  return { select };
}

const now = new Date("2026-05-03T12:00:00.000Z");
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-weekly-usage-smoke-"));
const usageFilePath = path.join(dir, "usage.json");
const deliveries: string[] = [];

const db = createDbStub([
  [
    {
      id: "run-codex-95",
      adapterType: "codex_local",
      finishedAt: new Date("2026-05-03T11:55:00.000Z"),
      createdAt: new Date("2026-05-03T11:54:00.000Z"),
      usageJson: { inputTokens: 90, outputTokens: 5 },
    },
  ],
  [
    {
      id: "agent-sd",
      companyId: "company-1",
      adapterType: "codex_local",
      role: "Scraper Developer",
      name: "Scraper Developer",
      title: null,
    },
  ],
  [
    {
      id: "agent-cto",
      companyId: "company-1",
      adapterType: "codex_local",
      role: "CTO",
      name: "CTO",
      title: "Chief Technology Officer",
    },
  ],
  [
    {
      id: "agent-ceo",
      companyId: "company-1",
      adapterType: "codex_local",
      role: "CEO",
      name: "CEO",
      title: "Chief Executive Officer",
    },
  ],
]) as any;

const service = weeklyUsageService(db, {
  usageFilePath,
  env: {
    PAPERCLIP_WEEKLY_USAGE_CAP_CODEX_LOCAL_TOKENS: "100",
    PAPERCLIP_WEEKLY_USAGE_CAP_CLAUDE_LOCAL_TOKENS: "100",
    PAPERCLIP_P0_TELEGRAM_BOT_TOKEN: "smoke-token",
    PAPERCLIP_P0_TELEGRAM_CHAT_ID: "smoke-chat",
  },
  now: () => now,
  fetch: (async (_url, init) => {
    deliveries.push(String(init?.body ?? ""));
    return new Response("{}", { status: 200 });
  }) as typeof fetch,
});

const snapshot = await service.updateFromHeartbeatRuns();
const nonCriticalBlock = await service.getInvocationBlock("company-1", "agent-sd");
const ctoBlock = await service.getInvocationBlock("company-1", "agent-cto");
const ceoBlock = await service.getInvocationBlock("company-1", "agent-ceo");

console.log("Weekly usage hard-stop smoke");
console.log(`usageFile=${usageFilePath}`);
console.log(`codexTokens=${snapshot.adapters.codex_local.totalTokens}`);
console.log(`codexHardStopped=${snapshot.adapters.codex_local.hardStopped}`);
console.log(`telegramDeliveries=${deliveries.length}`);
console.log(`nonCriticalBlocked=${Boolean(nonCriticalBlock)} reason=${nonCriticalBlock?.reason ?? "none"}`);
console.log(`ctoBlocked=${Boolean(ctoBlock)}`);
console.log(`ceoBlocked=${Boolean(ceoBlock)}`);
