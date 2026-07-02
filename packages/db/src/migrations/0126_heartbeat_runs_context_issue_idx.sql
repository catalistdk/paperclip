CREATE INDEX IF NOT EXISTS heartbeat_runs_company_status_issueid_idx
ON public.heartbeat_runs
  USING btree (company_id, status, ((context_snapshot ->> 'issueId')))
WHERE status IN ('queued', 'running');
