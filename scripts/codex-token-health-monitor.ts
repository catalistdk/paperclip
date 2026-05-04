#!/usr/bin/env -S pnpm exec tsx
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CODEX_TOKEN_REFRESH_THRESHOLD_MS,
  evaluateCodexTokenHealth,
  formatCodexTokenHealthBody,
  parseCodexAuthSnapshot,
} from "../server/src/services/codex-token-health.ts";
import {
  P0AlertService,
  formatP0AlertMessage,
  loadP0AlertConfigFromEnv,
} from "../server/src/services/p0-alerts.ts";

type Args = {
  dryRun: boolean;
  send: boolean;
  confirmSend: boolean;
  help: boolean;
  authFile: string;
  thresholdHours: number;
  now: Date;
  simulateAuthJson: string | null;
  issueId?: string;
  issueIdentifier?: string;
  issueTitle?: string;
};

function usage() {
  console.log(`Usage:
  scripts/codex-token-health-monitor.ts [--dry-run]
  scripts/codex-token-health-monitor.ts --send --confirm-send

Checks Codex local auth freshness by reading only timestamp metadata from ~/.codex/auth.json.
No OAuth, access, refresh, or API tokens are printed or persisted.

Options:
  --dry-run                  Print sanitized health evidence. Default.
  --send                     Send a P0 alert when auth is missing, invalid, or stale.
  --confirm-send             Required with --send.
  --auth-file PATH           Default: $CODEX_HOME/auth.json or ~/.codex/auth.json.
  --threshold-hours N        Default: 12.
  --simulate-auth-json PATH  Read sample auth JSON from PATH for verification.
  --now ISO                  Test clock override.
  --issue-id ID              Alert context.
  --issue-identifier KEY     Alert context, e.g. VER-480.
  --issue-title TITLE        Alert context.
  --help                     Show this text.

Exit codes:
  0: token health is fresh, or stale alert was sent
  2: stale/missing/invalid auth detected in dry-run mode
  4: send requested but alert channel is not configured`);
}

function defaultAuthFile() {
  return path.join(os.homedir(), ".codex", "auth.json");
}

function requireValue(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function positiveNumber(value: string, name: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function parseDate(value: string, name: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${name} must be a valid ISO timestamp`);
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: true,
    send: false,
    confirmSend: false,
    help: false,
    authFile: defaultAuthFile(),
    thresholdHours: DEFAULT_CODEX_TOKEN_REFRESH_THRESHOLD_MS / 60 / 60 / 1000,
    now: new Date(),
    simulateAuthJson: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run":
        args.dryRun = true;
        args.send = false;
        break;
      case "--send":
        args.send = true;
        args.dryRun = false;
        break;
      case "--confirm-send":
        args.confirmSend = true;
        break;
      case "--auth-file":
        args.authFile = path.resolve(requireValue(argv[++i], arg));
        break;
      case "--threshold-hours":
        args.thresholdHours = positiveNumber(requireValue(argv[++i], arg), arg);
        break;
      case "--simulate-auth-json":
        args.simulateAuthJson = path.resolve(requireValue(argv[++i], arg));
        break;
      case "--now":
        args.now = parseDate(requireValue(argv[++i], arg), arg);
        break;
      case "--issue-id":
        args.issueId = requireValue(argv[++i], arg);
        break;
      case "--issue-identifier":
        args.issueIdentifier = requireValue(argv[++i], arg);
        break;
      case "--issue-title":
        args.issueTitle = requireValue(argv[++i], arg);
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function readAuthJson(args: Args): string | null {
  try {
    return readFileSync(args.simulateAuthJson ?? args.authFile, "utf8");
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  if (args.send && !args.confirmSend) {
    throw new Error("--confirm-send is required with --send");
  }

  const auth = parseCodexAuthSnapshot(readAuthJson(args), args.simulateAuthJson ? `${args.authFile} (simulated)` : args.authFile);
  const result = evaluateCodexTokenHealth({
    now: args.now,
    thresholdMs: args.thresholdHours * 60 * 60 * 1000,
    auth,
  });

  console.log("Codex token health monitor");
  console.log(formatCodexTokenHealthBody(result));
  console.log(`Reason: ${result.reason}`);

  if (!result.alert) return;

  const alertInput = {
    dedupeKey: `codex-token-health:${args.authFile}`,
    title: "Codex token refresh is stale",
    operatorAction: "Refresh Codex local auth before waking more Codex agents.",
    body: formatCodexTokenHealthBody(result),
    context: {
      issueId: args.issueId,
      issueIdentifier: args.issueIdentifier,
      issueTitle: args.issueTitle,
    },
  };

  if (args.dryRun) {
    console.log("");
    console.log("Dry-run alert preview:");
    console.log(formatP0AlertMessage(alertInput, { tier: "standard" }));
    process.exitCode = 2;
    return;
  }

  const service = new P0AlertService({
    config: loadP0AlertConfigFromEnv(),
  });
  const sendResult = await service.alert(alertInput);
  console.log(`Alert outcome: ${sendResult.outcome}`);
  if (sendResult.outcome === "not_configured") {
    console.error("P0 alert channel is not configured; set PAPERCLIP_P0_TELEGRAM_BOT_TOKEN and PAPERCLIP_P0_TELEGRAM_CHAT_ID.");
    process.exitCode = 4;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
