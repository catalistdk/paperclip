import postgres from "postgres";

(async () => {
  const url = process.env.DATABASE_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    const sample = await sql`select company_id, context_snapshot->>'issueId' as issue_id from heartbeat_runs where status in ('queued','running') and context_snapshot->>'issueId' is not null limit 1`;
    const sampleRows = await sql`select company_id, context_snapshot->>'issueId' as issue_id from heartbeat_runs limit 1`;
    const issueRow = sample[0] ?? sampleRows[0];

    const companyId = issueRow?.company_id;
    const issueId = issueRow?.issue_id;

    if (!companyId || !issueId) {
      console.log("ABORT_NO_DATA");
      return;
    }

    const explain = (rows: Array<{ [key: string]: unknown }>) => {
      for (const row of rows as any[]) {
        const planLine = String(row["QUERY PLAN"]);
        if (planLine) console.log(planLine);
      }
    };

    const existing = await sql`SELECT to_regclass('public.heartbeat_runs_company_status_issueid_idx') IS NOT NULL AS exists`;
    console.log('INDEX_EXISTS_BEFORE', existing[0]?.exists ? 'yes' : 'no');

    const planSql = `
      EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
      SELECT id FROM heartbeat_runs
      WHERE company_id = $1
        AND status IN ('queued', 'running')
        AND context_snapshot ->> 'issueId' = $2
      ORDER BY created_at DESC
      LIMIT 20`;

    const beforePlanRows = await sql.unsafe(planSql, [companyId, issueId]);
    console.log('--- EXPLAIN_BEFORE ---');
    explain(beforePlanRows);

    if (existing[0]?.exists) {
      console.log('--- DROPPING_INDEX ---');
      await sql`DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_company_status_issueid_idx`;
    }

    const afterDropPlanRows = await sql.unsafe(planSql, [companyId, issueId]);
    console.log('--- EXPLAIN_AFTER_DROP_SIMULATING_BEFORE ---');
    explain(afterDropPlanRows);

    await sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_company_status_issueid_idx
      ON public.heartbeat_runs
      USING btree (company_id, status, ((context_snapshot ->> 'issueId')))
      WHERE status IN ('queued', 'running')`;

    await sql`SELECT pg_sleep(1)`;

    const afterCreatePlanRows = await sql.unsafe(planSql, [companyId, issueId]);
    console.log('--- EXPLAIN_AFTER_RECREATE ---');
    explain(afterCreatePlanRows);

    const indexSize = await sql`SELECT pg_size_pretty(pg_relation_size('heartbeat_runs_company_status_issueid_idx'::regclass)) AS idx_size`;
    console.log('--- INDEX_SIZE ---');
    console.log(indexSize[0]?.idx_size ?? 'unknown');
  } finally {
    await sql.end();
  }
})();
