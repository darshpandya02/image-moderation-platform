import type { Db } from "@/lib/db";
import type { Decision, Policy, Reason, Scores } from "@/lib/policy";
import type { Label } from "@/lib/classifier";
import type { JobStatus } from "./state";

export type ClaimedJob = {
  id: string;
  image_id: string;
  attempts: number;
  max_attempts: number;
};

export type ClaimOutcome =
  | { kind: "claimed"; job: ClaimedJob }
  | { kind: "missing" }
  | { kind: "terminal"; status: JobStatus }
  | { kind: "busy"; retryInSeconds: number }
  | { kind: "not_due"; retryInSeconds: number };

const CLAIMABLE = `(
  (status IN ('queued', 'retrying') AND next_attempt_at <= now() AND attempts < max_attempts)
  OR (status = 'processing' AND locked_until < now() AND attempts < max_attempts)
)`;

/**
 * Claims one specific job (push delivery from the queue). The WHERE clause is
 * re-checked after any row lock wait, so two deliveries of the same message
 * cannot both win: the loser sees status = 'processing' with a live lease.
 */
export async function claimJob(db: Db, jobId: string, leaseSeconds: number): Promise<ClaimOutcome> {
  const rows = await db.query<ClaimedJob>(
    `UPDATE image_moderation.jobs
        SET status = 'processing',
            attempts = attempts + 1,
            locked_until = now() + make_interval(secs => $2),
            started_at = COALESCE(started_at, now()),
            updated_at = now()
      WHERE id = $1 AND ${CLAIMABLE}
      RETURNING id, image_id, attempts, max_attempts`,
    [jobId, leaseSeconds],
  );
  if (rows[0]) return { kind: "claimed", job: rows[0] };

  const current = await db.query<{ status: JobStatus; lease_left: number | null; due_in: number | null }>(
    `SELECT status,
            CEIL(EXTRACT(EPOCH FROM (locked_until - now())))::int AS lease_left,
            CEIL(EXTRACT(EPOCH FROM (next_attempt_at - now())))::int AS due_in
       FROM image_moderation.jobs WHERE id = $1`,
    [jobId],
  );
  const row = current[0];
  if (!row) return { kind: "missing" };
  if (row.status === "completed" || row.status === "dead_letter") return { kind: "terminal", status: row.status };
  if (row.status === "processing") return { kind: "busy", retryInSeconds: Math.max(1, row.lease_left ?? 1) };
  return { kind: "not_due", retryInSeconds: Math.max(1, row.due_in ?? 1) };
}

/**
 * Pull-mode claim used by the sweeper: grabs up to `limit` due or abandoned
 * jobs. FOR UPDATE SKIP LOCKED lets several sweepers run at once without
 * blocking on, or double-claiming, the same rows.
 */
export async function claimDueJobs(db: Db, limit: number, leaseSeconds: number): Promise<ClaimedJob[]> {
  return db.query<ClaimedJob>(
    `UPDATE image_moderation.jobs j
        SET status = 'processing',
            attempts = j.attempts + 1,
            locked_until = now() + make_interval(secs => $2),
            started_at = COALESCE(j.started_at, now()),
            updated_at = now()
      WHERE j.id IN (
        SELECT id FROM image_moderation.jobs
         WHERE ${CLAIMABLE}
         ORDER BY next_attempt_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING j.id, j.image_id, j.attempts, j.max_attempts`,
    [limit, leaseSeconds],
  );
}

export type CompletionInput = {
  jobId: string;
  attempt: number;
  model: string;
  scores: Scores;
  labels: Label[];
  decision: Decision;
  reasons: Reason[];
  policy: Policy;
  inferenceMs: number;
};

/**
 * Records the result, moves the image to its decided status, marks the job
 * completed and writes the audit entry, all in one statement. `attempt` acts
 * as a fencing token: a worker whose lease was taken over cannot overwrite
 * the newer attempt's outcome.
 */
export async function completeJob(db: Db, input: CompletionInput): Promise<boolean> {
  const rows = await db.query<{ updated: number }>(
    `WITH j AS (
        UPDATE image_moderation.jobs
           SET status = 'completed', finished_at = now(), locked_until = NULL, last_error = NULL, updated_at = now()
         WHERE id = $1 AND status = 'processing' AND attempts = $2
         RETURNING id, image_id
      ), r AS (
        INSERT INTO image_moderation.moderation_results
          (image_id, job_id, model, scores, labels, decision, reasons, policy_id, policy_version, policy_snapshot, inference_ms)
        SELECT image_id, id, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8, $9, $10::jsonb, $11 FROM j
        ON CONFLICT (image_id) DO NOTHING
        RETURNING image_id
      ), i AS (
        UPDATE image_moderation.images
           SET status = $6, decided_at = now(), updated_at = now()
         WHERE id IN (SELECT image_id FROM r) AND status = 'pending'
         RETURNING id
      ), a AS (
        INSERT INTO image_moderation.audit_log (image_id, actor, action, from_status, to_status, details)
        SELECT id, 'system:worker', 'auto_decision', 'pending', $6, $12::jsonb FROM i
        RETURNING id
      )
      SELECT (SELECT count(*) FROM j)::int AS updated`,
    [
      input.jobId,
      input.attempt,
      input.model,
      JSON.stringify(input.scores),
      JSON.stringify(input.labels),
      input.decision,
      JSON.stringify(input.reasons),
      input.policy.id,
      input.policy.version,
      JSON.stringify(input.policy.thresholds),
      input.inferenceMs,
      JSON.stringify({ policy: input.policy.id, reasons: input.reasons, attempt: input.attempt }),
    ],
  );
  return Number(rows[0]?.updated ?? 0) === 1;
}

/**
 * Records a failed attempt. Below max_attempts the job goes to `retrying`
 * with a backoff; at the limit it is dead-lettered and the image marked
 * failed so it never silently disappears.
 */
export async function failJob(
  db: Db,
  { jobId, attempt, error, backoffSeconds }: { jobId: string; attempt: number; error: string; backoffSeconds: number },
): Promise<JobStatus | null> {
  const rows = await db.query<{ status: JobStatus }>(
    `WITH j AS (
        UPDATE image_moderation.jobs
           SET status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'retrying' END,
               next_attempt_at = now() + make_interval(secs => $4),
               locked_until = NULL,
               last_error = left($3, 1000),
               finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
               updated_at = now()
         WHERE id = $1 AND status = 'processing' AND attempts = $2
         RETURNING id, image_id, status
      ), i AS (
        UPDATE image_moderation.images SET status = 'failed', updated_at = now()
         WHERE id IN (SELECT image_id FROM j WHERE status = 'dead_letter') AND status = 'pending'
         RETURNING id
      ), a AS (
        INSERT INTO image_moderation.audit_log (image_id, actor, action, from_status, to_status, details)
        SELECT j.image_id, 'system:worker',
               CASE WHEN j.status = 'dead_letter' THEN 'dead_lettered' ELSE 'attempt_failed' END,
               'pending', CASE WHEN j.status = 'dead_letter' THEN 'failed' ELSE 'pending' END,
               jsonb_build_object('attempt', $2::int, 'error', left($3, 300), 'retry_in_seconds', $4::int)
          FROM j
        RETURNING id
      )
      SELECT status FROM j`,
    [jobId, attempt, error, backoffSeconds],
  );
  return rows[0]?.status ?? null;
}

/** Dead-letters jobs that crashed on their last allowed attempt. */
export async function deadLetterExhausted(db: Db): Promise<number> {
  const rows = await db.query<{ n: number }>(
    `WITH j AS (
        UPDATE image_moderation.jobs
           SET status = 'dead_letter', finished_at = now(), locked_until = NULL,
               last_error = COALESCE(last_error, 'lease expired on final attempt'), updated_at = now()
         WHERE status IN ('processing', 'retrying') AND attempts >= max_attempts
           AND (locked_until IS NULL OR locked_until < now())
         RETURNING image_id
      ), i AS (
        UPDATE image_moderation.images SET status = 'failed', updated_at = now()
         WHERE id IN (SELECT image_id FROM j) AND status = 'pending'
         RETURNING id
      ), a AS (
        INSERT INTO image_moderation.audit_log (image_id, actor, action, from_status, to_status)
        SELECT id, 'system:sweeper', 'dead_lettered', 'pending', 'failed' FROM i
        RETURNING id
      )
      SELECT (SELECT count(*) FROM j)::int AS n`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Marks a queued job as re-published if it has been waiting longer than
 * `staleSeconds`. Returns true for exactly one caller per stale period, so
 * a crowd of status pollers triggers at most one re-publish.
 */
export async function markRepublish(db: Db, jobId: string, staleSeconds: number): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE image_moderation.jobs SET last_enqueue_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('queued', 'retrying')
        AND next_attempt_at <= now()
        AND last_enqueue_at < now() - make_interval(secs => $2)
      RETURNING id`,
    [jobId, staleSeconds],
  );
  return rows.length === 1;
}
