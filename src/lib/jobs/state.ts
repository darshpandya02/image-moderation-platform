/**
 * Moderation job state machine.
 *
 *   queued ──claim──▶ processing ──complete──▶ completed
 *                        │  ▲
 *                  fail  │  │ claim (after backoff)
 *                        ▼  │
 *                      retrying ──(attempts exhausted)──▶ dead_letter
 *
 * A `processing` job whose lease expired can be claimed again; that covers a
 * worker that crashed mid-job. `completed` and `dead_letter` are terminal.
 * The SQL in repo.ts enforces the same rules with conditional updates; this
 * module is the single source of truth for which transitions are legal.
 */

export const JOB_STATUSES = ["queued", "processing", "retrying", "completed", "dead_letter"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type JobEvent = "claim" | "complete" | "fail" | "reclaim_expired";

export const TERMINAL: ReadonlySet<JobStatus> = new Set(["completed", "dead_letter"]);

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: JobStatus,
    readonly event: JobEvent,
  ) {
    super(`illegal job transition: ${event} from ${from}`);
  }
}

export type JobSnapshot = {
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
};

/** Returns the next status, or throws if the event is not legal in the current state. */
export function transition(job: JobSnapshot, event: JobEvent): JobStatus {
  switch (event) {
    case "claim":
      if (job.status === "queued" || job.status === "retrying") return "processing";
      break;
    case "reclaim_expired":
      if (job.status === "processing") return "processing";
      break;
    case "complete":
      if (job.status === "processing") return "completed";
      break;
    case "fail":
      if (job.status === "processing") {
        return job.attempts >= job.maxAttempts ? "dead_letter" : "retrying";
      }
      break;
  }
  throw new IllegalTransitionError(job.status, event);
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * Exponential backoff with full jitter, in seconds.
 * attempt 1 -> up to 2s, 2 -> up to 4s, 3 -> up to 8s ... capped at `capSeconds`.
 */
export function backoffSeconds(
  attempt: number,
  { baseSeconds = 2, capSeconds = 120, random = Math.random }: { baseSeconds?: number; capSeconds?: number; random?: () => number } = {},
): number {
  const ceiling = Math.min(capSeconds, baseSeconds * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.ceil(ceiling * random()));
}

/** The status users see: queued, processing, or decided. */
export type PublicStage = "uploading" | "queued" | "processing" | "decided" | "failed";

export function publicStage(imageStatus: string, jobStatus: JobStatus | null): PublicStage {
  if (imageStatus === "awaiting_upload") return "uploading";
  if (imageStatus === "failed" || jobStatus === "dead_letter") return "failed";
  if (imageStatus === "approved" || imageStatus === "rejected" || imageStatus === "needs_review") return "decided";
  if (jobStatus === "processing") return "processing";
  return "queued";
}
