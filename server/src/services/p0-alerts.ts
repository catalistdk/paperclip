import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface P0AlertContext {
  issueId?: string;
  issueIdentifier?: string;
  issueTitle?: string;
  runId?: string;
  agentId?: string;
  companyId?: string;
}

export interface P0AlertInput {
  dedupeKey: string;
  title: string;
  operatorAction: string;
  body?: string;
  context?: P0AlertContext;
}

export interface P0AlertConfig {
  telegramBotToken?: string;
  telegramChatId?: string;
  pushoverAppToken?: string;
  pushoverUserKey?: string;
  fallbackWebhookUrl?: string;
  stateFilePath?: string;
  firstWindowMs: number;
  urgentWindowMs: number;
  fallbackWindowMs: number;
  dedupeTtlMs: number;
}

export type P0AlertDeliveryChannel = "telegram" | "pushover" | "webhook" | "stub";
export type P0AlertOutcome = "sent" | "deduped" | "escalated" | "not_configured";

export interface P0AlertDelivery {
  channel: P0AlertDeliveryChannel;
  escalated: boolean;
}

export interface P0AlertResult {
  outcome: P0AlertOutcome;
  deliveries: P0AlertDelivery[];
  dedupeKey: string;
}

interface P0AlertState {
  seenAt: number[];
  lastSeenAt: number;
  standardTelegramSentAt?: number;
  urgentTelegramSentAt?: number;
  fallbackSentAt?: number;
  acknowledgedAt?: number;
}

export interface P0AlertServiceOptions {
  config: P0AlertConfig;
  fetch?: typeof fetch;
  now?: () => number;
}

const DEFAULT_FIRST_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_URGENT_WINDOW_MS = 4 * 60 * 60 * 1000;
const DEFAULT_FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEDUPE_TTL_MS = DEFAULT_FALLBACK_WINDOW_MS;
const DEFAULT_STATE_FILE = path.join(os.homedir(), ".paperclip", "p0-alert-state.json");

export function loadP0AlertConfigFromEnv(env: NodeJS.ProcessEnv = process.env): P0AlertConfig {
  return {
    telegramBotToken: cleanEnv(env.PAPERCLIP_P0_TELEGRAM_BOT_TOKEN),
    telegramChatId: cleanEnv(env.PAPERCLIP_P0_TELEGRAM_CHAT_ID),
    pushoverAppToken: cleanEnv(env.PAPERCLIP_P0_PUSHOVER_APP_TOKEN),
    pushoverUserKey: cleanEnv(env.PAPERCLIP_P0_PUSHOVER_USER_KEY),
    fallbackWebhookUrl: cleanEnv(env.PAPERCLIP_P0_FALLBACK_WEBHOOK_URL),
    stateFilePath: cleanEnv(env.PAPERCLIP_P0_ALERT_STATE_FILE) ?? DEFAULT_STATE_FILE,
    firstWindowMs: positiveNumber(env.PAPERCLIP_P0_FIRST_WINDOW_MS, DEFAULT_FIRST_WINDOW_MS),
    urgentWindowMs: positiveNumber(env.PAPERCLIP_P0_URGENT_WINDOW_MS, DEFAULT_URGENT_WINDOW_MS),
    fallbackWindowMs: positiveNumber(env.PAPERCLIP_P0_FALLBACK_WINDOW_MS, DEFAULT_FALLBACK_WINDOW_MS),
    dedupeTtlMs: positiveNumber(env.PAPERCLIP_P0_DEDUPE_TTL_MS, DEFAULT_DEDUPE_TTL_MS),
  };
}

export class P0AlertService {
  private readonly config: P0AlertConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly states = new Map<string, P0AlertState>();

  constructor(options: P0AlertServiceOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async alert(input: P0AlertInput): Promise<P0AlertResult> {
    const now = this.now();
    await this.loadPersistedState();
    this.prune(now);

    const existing = this.states.get(input.dedupeKey);
    if (!existing || existing.acknowledgedAt) {
      const state: P0AlertState = {
        seenAt: [now],
        lastSeenAt: now,
      };
      this.states.set(input.dedupeKey, state);
      const result = await this.sendTelegram(input, state, "standard");
      await this.persistState();
      return result;
    }

    existing.seenAt.push(now);
    existing.lastSeenAt = now;
    existing.seenAt = withinWindow(existing.seenAt, now, this.config.fallbackWindowMs);

    if (!wasSentWithin(existing.standardTelegramSentAt, now, this.config.firstWindowMs)) {
      const result = await this.sendTelegram(input, existing, "standard");
      await this.persistState();
      return result;
    }

    const urgentCount = countWithin(existing.seenAt, now, this.config.urgentWindowMs);
    if (
      urgentCount >= 3 &&
      !wasSentWithin(existing.urgentTelegramSentAt, now, this.config.urgentWindowMs)
    ) {
      const result = await this.sendTelegram(input, existing, "urgent");
      await this.persistState();
      return result;
    }

    const fallbackCount = countWithin(existing.seenAt, now, this.config.fallbackWindowMs);
    if (
      fallbackCount >= 5 &&
      !wasSentWithin(existing.fallbackSentAt, now, this.config.fallbackWindowMs)
    ) {
      const result = await this.sendFallback(input, existing);
      await this.persistState();
      return result;
    }

    await this.persistState();
    return { outcome: "deduped", deliveries: [], dedupeKey: input.dedupeKey };
  }

  async acknowledge(dedupeKey: string): Promise<boolean> {
    await this.loadPersistedState();
    const state = this.states.get(dedupeKey);
    if (!state) return false;
    this.states.delete(dedupeKey);
    await this.persistState();
    return true;
  }

  resolve(dedupeKey: string): Promise<boolean> {
    return this.acknowledge(dedupeKey);
  }

  private async sendTelegram(
    input: P0AlertInput,
    state: P0AlertState,
    tier: "standard" | "urgent",
  ): Promise<P0AlertResult> {
    if (!this.config.telegramBotToken || !this.config.telegramChatId) {
      return { outcome: "not_configured", deliveries: [], dedupeKey: input.dedupeKey };
    }

    const escalated = tier === "urgent";
    const url = `https://api.telegram.org/bot${encodeURIComponent(this.config.telegramBotToken)}/sendMessage`;
    await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: this.config.telegramChatId,
        text: formatP0AlertMessage(input, { tier }),
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    if (tier === "urgent") state.urgentTelegramSentAt = this.now();
    else state.standardTelegramSentAt = this.now();
    return {
      outcome: escalated ? "escalated" : "sent",
      deliveries: [{ channel: "telegram", escalated }],
      dedupeKey: input.dedupeKey,
    };
  }

  private async sendFallback(input: P0AlertInput, state: P0AlertState): Promise<P0AlertResult> {
    const message = formatP0AlertMessage(input, { tier: "fallback" });
    if (this.config.pushoverAppToken && this.config.pushoverUserKey) {
      await this.fetchImpl("https://api.pushover.net/1/messages.json", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: this.config.pushoverAppToken,
          user: this.config.pushoverUserKey,
          title: `P0 ESCALATION: ${input.title}`,
          message,
          priority: "2",
          retry: "60",
          expire: "3600",
        }).toString(),
      });
      state.fallbackSentAt = this.now();
      return {
        outcome: "escalated",
        deliveries: [{ channel: "pushover", escalated: true }],
        dedupeKey: input.dedupeKey,
      };
    }

    if (this.config.fallbackWebhookUrl) {
      await this.fetchImpl(this.config.fallbackWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          severity: "P0",
          title: input.title,
          text: message,
          operatorAction: input.operatorAction,
          dedupeKey: input.dedupeKey,
          context: input.context ?? {},
        }),
      });
      state.fallbackSentAt = this.now();
      return {
        outcome: "escalated",
        deliveries: [{ channel: "webhook", escalated: true }],
        dedupeKey: input.dedupeKey,
      };
    }

    state.fallbackSentAt = this.now();
    return {
      outcome: "escalated",
      deliveries: [{ channel: "stub", escalated: true }],
      dedupeKey: input.dedupeKey,
    };
  }

  private prune(now: number): void {
    for (const [key, state] of this.states.entries()) {
      state.seenAt = withinWindow(state.seenAt, now, this.config.fallbackWindowMs);
      if (now - state.lastSeenAt >= this.config.dedupeTtlMs) {
        this.states.delete(key);
      }
    }
  }

  private loadedState = false;

  private async loadPersistedState(): Promise<void> {
    if (this.loadedState || !this.config.stateFilePath) return;
    this.loadedState = true;
    try {
      const raw = await fs.readFile(this.config.stateFilePath, "utf8");
      const parsed = JSON.parse(raw) as { states?: Record<string, Partial<P0AlertState>> };
      for (const [key, value] of Object.entries(parsed.states ?? {})) {
        const seenAt = Array.isArray(value.seenAt)
          ? value.seenAt.filter((entry): entry is number => Number.isFinite(entry))
          : [];
        const lastSeenAt = finiteOrUndefined(value.lastSeenAt);
        if (seenAt.length === 0 || lastSeenAt === undefined) continue;
        this.states.set(key, {
          seenAt,
          lastSeenAt,
          standardTelegramSentAt: finiteOrUndefined(value.standardTelegramSentAt),
          urgentTelegramSentAt: finiteOrUndefined(value.urgentTelegramSentAt),
          fallbackSentAt: finiteOrUndefined(value.fallbackSentAt),
          acknowledgedAt: finiteOrUndefined(value.acknowledgedAt),
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persistState(): Promise<void> {
    if (!this.config.stateFilePath) return;
    const states = Object.fromEntries(this.states.entries());
    await fs.mkdir(path.dirname(this.config.stateFilePath), { recursive: true });
    await fs.writeFile(
      this.config.stateFilePath,
      JSON.stringify({ version: 1, updatedAt: new Date(this.now()).toISOString(), states }, null, 2),
    );
  }
}

export function formatP0AlertMessage(
  input: P0AlertInput,
  opts: { tier: "standard" | "urgent" | "fallback" } | { escalated: boolean },
): string {
  const tier = "tier" in opts ? opts.tier : opts.escalated ? "urgent" : "standard";
  const lines = [
    tier === "standard"
      ? "P0 EMERGENCY"
      : tier === "urgent"
        ? "🚨🚨 *P0 ESCALATION: repeated identical alarm*"
        : "P0 PHONE FALLBACK",
    input.title,
    "",
    `Action: ${input.operatorAction}`,
  ];

  if (input.body) {
    lines.push("", input.body);
  }

  const contextLines = formatContext(input.context);
  if (contextLines.length > 0) {
    lines.push("", "Context:", ...contextLines);
  }

  lines.push("", `Dedupe: ${input.dedupeKey}`);
  return lines.join("\n");
}

function formatContext(context: P0AlertContext | undefined): string[] {
  if (!context) return [];
  return [
    ["Issue", context.issueIdentifier ?? context.issueId],
    ["Title", context.issueTitle],
    ["Run", context.runId],
    ["Agent", context.agentId],
    ["Company", context.companyId],
  ].flatMap(([label, value]) => value ? [`- ${label}: ${value}`] : []);
}

function cleanEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function withinWindow(values: number[], now: number, windowMs: number): number[] {
  return values.filter((value) => now - value <= windowMs);
}

function countWithin(values: number[], now: number, windowMs: number): number {
  return withinWindow(values, now, windowMs).length;
}

function wasSentWithin(sentAt: number | undefined, now: number, windowMs: number): boolean {
  return Number.isFinite(sentAt) && now - Number(sentAt) <= windowMs;
}

function finiteOrUndefined(value: unknown): number | undefined {
  return Number.isFinite(value) ? Number(value) : undefined;
}
