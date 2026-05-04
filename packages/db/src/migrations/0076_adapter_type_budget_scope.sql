ALTER TABLE "budget_policies"
  ALTER COLUMN "scope_id" TYPE text USING "scope_id"::text;
--> statement-breakpoint
ALTER TABLE "budget_incidents"
  ALTER COLUMN "scope_id" TYPE text USING "scope_id"::text;
--> statement-breakpoint
ALTER TABLE "cost_events"
  ADD COLUMN IF NOT EXISTS "adapter_type" text NOT NULL DEFAULT 'unknown';
--> statement-breakpoint
UPDATE "cost_events"
SET "adapter_type" = coalesce("agents"."adapter_type", 'unknown')
FROM "agents"
WHERE "cost_events"."agent_id" = "agents"."id"
  AND "cost_events"."company_id" = "agents"."company_id"
  AND "cost_events"."adapter_type" = 'unknown';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_events_company_adapter_occurred_idx"
  ON "cost_events" ("company_id", "adapter_type", "occurred_at");
