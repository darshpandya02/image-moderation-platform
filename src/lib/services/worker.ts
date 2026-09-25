import { getClassifier, type Classifier } from "@/lib/classifier";
import { getDb, type Db } from "@/lib/db";
import { MAX_UPLOAD_BYTES } from "@/lib/images/validate";
import {
  claimDueJobs,
  claimJob,
  completeJob,
  deadLetterExhausted,
  failJob,
  type ClaimedJob,
} from "@/lib/jobs/repo";
import { backoffSeconds } from "@/lib/jobs/state";
import { evaluatePolicy, validateScores } from "@/lib/policy";
import { getBlobStore, type BlobStore } from "@/lib/storage";
import { getPolicy } from "./policies";

export const LEASE_SECONDS = 120;

/** Thrown to ask the queue to redeliver later instead of using its default delay. */
export class RetryLaterError extends Error {
  constructor(
    readonly afterSeconds: number,
    message: string,
  ) {
    super(message);
  }
}

export type WorkerDeps = { db: Db; blob: BlobStore; classifier: () => Promise<Classifier> };

export type ProcessOutcome =
  | { outcome: "completed"; decision: string }
  | { outcome: "already_done" | "missing" | "lost_lease" | "dead_letter" };

function defaultDeps(): WorkerDeps {
  return { db: getDb(), blob: getBlobStore(), classifier: getClassifier };
}

async function runClaimed(deps: WorkerDeps, job: ClaimedJob): Promise<ProcessOutcome> {
  try {
    const images = await deps.db.query<{ blob_path: string | null; policy_id: string }>(
      `SELECT blob_path, policy_id FROM image_moderation.images WHERE id = $1`,
      [job.image_id],
    );
    const image = images[0];
    if (!image?.blob_path) throw new Error("image has no stored blob");

    const data = await deps.blob.read(image.blob_path, MAX_UPLOAD_BYTES * 2);
    if (!data) throw new Error(`blob ${image.blob_path} not found`);

    const policy = await getPolicy(deps.db, image.policy_id);
    if (!policy) throw new Error(`policy ${image.policy_id} not found`);

    const classifier = await deps.classifier();
    const result = await classifier.classify(data);
    const scores = validateScores(result.scores);
    const { decision, reasons } = evaluatePolicy(scores, policy);

    const ok = await completeJob(deps.db, {
      jobId: job.id,
      attempt: job.attempts,
      model: result.model,
      scores,
      labels: result.labels,
      decision,
      reasons,
      policy,
      inferenceMs: result.inferenceMs,
    });
    return ok ? { outcome: "completed", decision } : { outcome: "lost_lease" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const delay = backoffSeconds(job.attempts);
    const status = await failJob(deps.db, { jobId: job.id, attempt: job.attempts, error: message, backoffSeconds: delay });
    if (status === "dead_letter") return { outcome: "dead_letter" };
    if (status === null) return { outcome: "lost_lease" };
    throw new RetryLaterError(delay, `attempt ${job.attempts} failed: ${message}`);
  }
}

/**
 * Idempotent handler for one queue message. Safe under at-least-once
 * delivery: duplicates of a finished job are acknowledged without work, and
 * a duplicate that arrives while another instance holds the lease is told to
 * come back when the lease ends.
 */
export async function processJob(jobId: string, deps: WorkerDeps = defaultDeps()): Promise<ProcessOutcome> {
  const claim = await claimJob(deps.db, jobId, LEASE_SECONDS);
  switch (claim.kind) {
    case "missing":
      return { outcome: "missing" };
    case "terminal":
      return { outcome: "already_done" };
    case "busy":
      throw new RetryLaterError(claim.retryInSeconds, "job is leased by another worker");
    case "not_due":
      throw new RetryLaterError(claim.retryInSeconds, "job is backing off");
    case "claimed":
      return runClaimed(deps, claim.job);
  }
}

/**
 * Pull-mode fallback: drains due, retrying or abandoned jobs straight from
 * Postgres with SKIP LOCKED. Runs from the cron route and the local worker.
 */
export async function sweep(
  { limit = 10, deps = defaultDeps() }: { limit?: number; deps?: WorkerDeps } = {},
): Promise<{ claimed: number; outcomes: string[]; deadLettered: number }> {
  const deadLettered = await deadLetterExhausted(deps.db);
  const jobs = await claimDueJobs(deps.db, limit, LEASE_SECONDS);
  const outcomes: string[] = [];
  for (const job of jobs) {
    try {
      outcomes.push((await runClaimed(deps, job)).outcome);
    } catch (err) {
      outcomes.push(err instanceof RetryLaterError ? "retrying" : "error");
    }
  }
  await deps.db.query(
    `DELETE FROM image_moderation.images WHERE status = 'awaiting_upload' AND created_at < now() - interval '1 day'`,
  );
  return { claimed: jobs.length, outcomes, deadLettered };
}
