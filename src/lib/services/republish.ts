import type { Db } from "@/lib/db";
import { markRepublish } from "@/lib/jobs/repo";
import type { Publisher } from "@/lib/queue";

export const STALE_QUEUED_SECONDS = 20;

/**
 * If a job has sat in `queued` for a while (for example the publish call
 * failed after the job row was committed), publish it again. The guarded
 * UPDATE makes sure only one poller per period does this.
 */
export async function republishIfStale(db: Db, publisher: Publisher, jobId: string): Promise<boolean> {
  if (!(await markRepublish(db, jobId, STALE_QUEUED_SECONDS))) return false;
  try {
    await publisher.publish({ jobId }, `${jobId}:${Math.floor(Date.now() / 1000)}`);
    return true;
  } catch (err) {
    console.error("republish failed", jobId, err);
    return false;
  }
}
