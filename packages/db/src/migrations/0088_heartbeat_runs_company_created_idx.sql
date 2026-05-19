CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_company_created_idx
ON public.heartbeat_runs
  USING btree (company_id, created_at DESC);
