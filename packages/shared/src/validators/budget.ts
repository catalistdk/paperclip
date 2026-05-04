import { z } from "zod";
import {
  BUDGET_INCIDENT_RESOLUTION_ACTIONS,
  BUDGET_METRICS,
  BUDGET_SCOPE_TYPES,
  BUDGET_WINDOW_KINDS,
} from "../constants.js";

const adapterTypeScopeIdSchema = z.string().trim().min(1).max(128).refine((value) => {
  return /^[a-z0-9_.:-]+$/i.test(value);
}, "adapter_type scopeId must be an adapter type key");

export const upsertBudgetPolicySchema = z.object({
  scopeType: z.enum(BUDGET_SCOPE_TYPES),
  scopeId: z.string(),
  metric: z.enum(BUDGET_METRICS).optional().default("billed_cents"),
  windowKind: z.enum(BUDGET_WINDOW_KINDS).optional().default("calendar_month_utc"),
  amount: z.number().int().nonnegative(),
  warnPercent: z.number().int().min(1).max(99).optional().default(80),
  hardStopEnabled: z.boolean().optional().default(true),
  notifyEnabled: z.boolean().optional().default(true),
  isActive: z.boolean().optional().default(true),
}).superRefine((value, ctx) => {
  if (value.scopeType === "adapter_type") {
    const parsed = adapterTypeScopeIdSchema.safeParse(value.scopeId);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: parsed.error.issues[0]?.message ?? "Invalid adapter type",
        path: ["scopeId"],
      });
    }
    return;
  }

  if (!z.string().uuid().safeParse(value.scopeId).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${value.scopeType} scopeId must be a UUID`,
      path: ["scopeId"],
    });
  }
});

export type UpsertBudgetPolicy = z.infer<typeof upsertBudgetPolicySchema>;

export const resolveBudgetIncidentSchema = z.object({
  action: z.enum(BUDGET_INCIDENT_RESOLUTION_ACTIONS),
  amount: z.number().int().nonnegative().optional(),
  decisionNote: z.string().optional().nullable(),
}).superRefine((value, ctx) => {
  if (value.action === "raise_budget_and_resume" && typeof value.amount !== "number") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "amount is required when raising a budget",
      path: ["amount"],
    });
  }
});

export type ResolveBudgetIncident = z.infer<typeof resolveBudgetIncidentSchema>;
