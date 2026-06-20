import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, isNotNull, isNull, lte } from "drizzle-orm";
import { boardApiKeys, type Db } from "@paperclipai/db";
import type {
  P0AlertInput,
  P0AlertOutcome,
  P0AlertResult,
} from "./p0-alerts.js";

export const BOARD_KEY_EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;
export const BOARD_KEY_EXPIRY_DEDUPE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_BOARD_KEY_EXPIRY_DEDUPE_PATH = path.join(
  os.homedir(),
  ".paperclip",
  "board-key-expiry-dedupe.json",
);

export interface ExpiringBoardApiKey {
  id: string;
  name: string;
  expiresAt: Date;
  hoursRemaining: number;
}

export interface BoardKeyExpiryAlertSink {
  alert(input: P0AlertInput): Promise<P0AlertResult>;
}

export interface BoardKeyExpiryDedupeStore {
  load(): Promise<Record<string, number>>;
  save(state: Record<string, number>): Promise<void>;
}

export interface TickBoardKeyExpiryOptions {
  db: Db;
  alertSink: BoardKeyExpiryAlertSink;
  dedupeStore: BoardKeyExpiryDedupeStore;
  now?: Date;
  warningWindowMs?: number;
  dedupeWindowMs?: number;
  logger?: { info: (data: unknown, msg?: string) => void; warn: (data: unknown, msg?: string) => void };
}

export interface TickBoardKeyExpiryResult {
  checked: number;
  alerted: number;
  deduped: number;
  outcomes: Array<{ id: string; outcome: P0AlertOutcome | "deduped_local" }>;
}

export async function findExpiringBoardApiKeys(
  db: Db,
  now: Date,
  warningWindowMs: number = BOARD_KEY_EXPIRY_WARNING_MS,
): Promise<ExpiringBoardApiKey[]> {
  const cutoff = new Date(now.getTime() + warningWindowMs);
  const rows = await db
    .select({
      id: boardApiKeys.id,
      name: boardApiKeys.name,
      expiresAt: boardApiKeys.expiresAt,
    })
    .from(boardApiKeys)
    .where(
      and(
        isNull(boardApiKeys.revokedAt),
        isNotNull(boardApiKeys.expiresAt),
        lte(boardApiKeys.expiresAt, cutoff),
      ),
    );

  return rows
    .filter((row): row is { id: string; name: string; expiresAt: Date } => row.expiresAt instanceof Date)
    .map((row) => ({
      id: row.id,
      name: row.name,
      expiresAt: row.expiresAt,
      hoursRemaining: (row.expiresAt.getTime() - now.getTime()) / (60 * 60 * 1000),
    }));
}

export function formatBoardKeyExpiryAlert(key: ExpiringBoardApiKey): P0AlertInput {
  const hoursRounded = Math.round(key.hoursRemaining * 10) / 10;
  const expired = key.hoursRemaining <= 0;
  const titleSuffix = expired
    ? `EXPIRED ${Math.abs(hoursRounded)}h ago`
    : `expires in ${hoursRounded}h`;

  return {
    dedupeKey: `board_key_expiry:${key.id}`,
    title: `BOARD_KEY "${key.name}" ${titleSuffix}`,
    operatorAction:
      "Rotate the board API key per docs/runbooks/board-api-key-expiry-rotation.md. CI/CD writes against /board/* will start returning 401 once the key expires.",
    body: [
      `Key id: ${key.id}`,
      `Key name: ${key.name}`,
      `Expires at: ${key.expiresAt.toISOString()}`,
      `Hours remaining: ${hoursRounded}`,
    ].join("\n"),
  };
}

export function createFileBackedBoardKeyDedupeStore(
  filePath: string = DEFAULT_BOARD_KEY_EXPIRY_DEDUPE_PATH,
): BoardKeyExpiryDedupeStore {
  return {
    async load() {
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as { sentAt?: Record<string, unknown> };
        const out: Record<string, number> = {};
        for (const [id, value] of Object.entries(parsed.sentAt ?? {})) {
          if (typeof value === "number" && Number.isFinite(value)) out[id] = value;
        }
        return out;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
      }
    },
    async save(state) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        JSON.stringify(
          { version: 1, updatedAt: new Date().toISOString(), sentAt: state },
          null,
          2,
        ),
      );
    },
  };
}

export async function tickBoardKeyExpiry(
  options: TickBoardKeyExpiryOptions,
): Promise<TickBoardKeyExpiryResult> {
  const now = options.now ?? new Date();
  const warningWindowMs = options.warningWindowMs ?? BOARD_KEY_EXPIRY_WARNING_MS;
  const dedupeWindowMs = options.dedupeWindowMs ?? BOARD_KEY_EXPIRY_DEDUPE_MS;

  const expiring = await findExpiringBoardApiKeys(options.db, now, warningWindowMs);
  const result: TickBoardKeyExpiryResult = {
    checked: expiring.length,
    alerted: 0,
    deduped: 0,
    outcomes: [],
  };

  if (expiring.length === 0) {
    return result;
  }

  const state = await options.dedupeStore.load();
  const nowMs = now.getTime();

  for (const key of expiring) {
    const lastSent = state[key.id];
    if (typeof lastSent === "number" && nowMs - lastSent < dedupeWindowMs) {
      result.deduped += 1;
      result.outcomes.push({ id: key.id, outcome: "deduped_local" });
      continue;
    }

    const alertInput = formatBoardKeyExpiryAlert(key);
    const alertResult = await options.alertSink.alert(alertInput);
    result.outcomes.push({ id: key.id, outcome: alertResult.outcome });

    if (alertResult.outcome === "deduped") {
      result.deduped += 1;
      // Track in our local store anyway so we do not retry within the window.
      state[key.id] = nowMs;
    } else {
      result.alerted += 1;
      state[key.id] = nowMs;
      options.logger?.warn(
        {
          boardKeyId: key.id,
          boardKeyName: key.name,
          expiresAt: key.expiresAt.toISOString(),
          hoursRemaining: key.hoursRemaining,
          outcome: alertResult.outcome,
        },
        "BOARD_KEY expiry alert fired",
      );
    }
  }

  // Prune entries that are no longer expiring AND older than the dedupe window
  // so the file does not grow unbounded as keys get rotated.
  const expiringIds = new Set(expiring.map((k) => k.id));
  for (const id of Object.keys(state)) {
    if (!expiringIds.has(id) && nowMs - (state[id] ?? 0) > dedupeWindowMs) {
      delete state[id];
    }
  }

  await options.dedupeStore.save(state);
  return result;
}
