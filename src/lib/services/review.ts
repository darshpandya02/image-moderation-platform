import type { Db } from "@/lib/db";
import { HttpError } from "./uploads";

export type ReviewAction = "approve" | "reject";

const TARGET: Record<ReviewAction, "approved" | "rejected"> = { approve: "approved", reject: "rejected" };

/**
 * Applies a reviewer decision and its audit entry atomically. The row is
 * locked while the old status is read, so two reviewers acting at once get
 * one success and one 409 instead of a lost update.
 */
export async function reviewImage(
  db: Db,
  { imageId, action, reviewer, note }: { imageId: string; action: unknown; reviewer: string; note?: unknown },
) {
  if (action !== "approve" && action !== "reject") throw new HttpError(400, "bad_action", "action must be approve or reject");
  const cleanNote = typeof note === "string" ? note.slice(0, 500) : null;
  const to = TARGET[action];

  const rows = await db.query<{ from_status: string; audit_id: string }>(
    `WITH old AS (
        SELECT id, status FROM image_moderation.images
         WHERE id = $1 AND status IN ('needs_review', 'approved', 'rejected') AND status <> $2
         FOR UPDATE
      ), i AS (
        UPDATE image_moderation.images im
           SET status = $2, decided_at = now(), updated_at = now()
          FROM old WHERE im.id = old.id
         RETURNING im.id, old.status AS from_status
      ), a AS (
        INSERT INTO image_moderation.audit_log (image_id, actor, action, from_status, to_status, note)
        SELECT id, $3, $4, from_status, $2, $5 FROM i
        RETURNING id
      )
      SELECT i.from_status, a.id::text AS audit_id FROM i, a`,
    [imageId, to, reviewer, `review_${action}`, cleanNote],
  );
  if (!rows[0]) {
    const exists = await db.query<{ status: string }>(`SELECT status FROM image_moderation.images WHERE id = $1`, [imageId]);
    if (!exists[0]) throw new HttpError(404, "not_found", "unknown image");
    throw new HttpError(409, "conflict", `image is ${exists[0].status}; cannot ${action}`);
  }
  return { imageId, from: rows[0].from_status, to, auditId: rows[0].audit_id };
}
