import type { Db } from "@/lib/db";
import type { JobStatus } from "@/lib/jobs/state";
import { publicStage, type PublicStage } from "@/lib/jobs/state";
import { nsfwScore, type Reason, type Scores } from "@/lib/policy";
import type { Label } from "@/lib/classifier";

type StatusRow = {
  id: string;
  status: string;
  policy_id: string;
  width: number | null;
  height: number | null;
  bytes_stored: number | null;
  exif_removed: boolean | null;
  created_at: Date | string;
  uploaded_at: Date | string | null;
  decided_at: Date | string | null;
  job_id: string | null;
  job_status: JobStatus | null;
  attempts: number | null;
  last_error: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  scores: Scores | null;
  labels: Label[] | null;
  decision: string | null;
  reasons: Reason[] | null;
  inference_ms: number | null;
  model: string | null;
};

export type ImageStatus = {
  id: string;
  stage: PublicStage;
  status: string;
  policyId: string;
  job: { id: string; status: JobStatus; attempts: number; lastError: string | null } | null;
  result: {
    autoDecision: string;
    scores: Scores;
    nsfw: number;
    labels: Label[];
    reasons: Reason[];
    inferenceMs: number;
    model: string;
  } | null;
  image: { width: number | null; height: number | null; bytes: number | null; metadataRemoved: boolean | null };
  timestamps: {
    created: string;
    uploaded: string | null;
    processingStarted: string | null;
    decided: string | null;
  };
};

const iso = (v: Date | string | null) => (v == null ? null : new Date(v).toISOString());

const parse = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));

export async function getImageStatus(db: Db, id: string): Promise<ImageStatus | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await db.query<StatusRow>(
    `SELECT i.id, i.status, i.policy_id, i.width, i.height, i.bytes_stored, i.exif_removed,
            i.created_at, i.uploaded_at, i.decided_at,
            j.id AS job_id, j.status AS job_status, j.attempts, j.last_error, j.started_at, j.finished_at,
            r.scores, r.labels, r.decision, r.reasons, r.inference_ms, r.model
       FROM image_moderation.images i
       LEFT JOIN image_moderation.jobs j ON j.image_id = i.id
       LEFT JOIN image_moderation.moderation_results r ON r.image_id = i.id
      WHERE i.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  const scores = r.scores ? parse<Scores>(r.scores) : null;
  return {
    id: r.id,
    stage: publicStage(r.status, r.job_status),
    status: r.status,
    policyId: r.policy_id,
    job: r.job_id
      ? { id: r.job_id, status: r.job_status!, attempts: Number(r.attempts ?? 0), lastError: r.last_error }
      : null,
    result:
      scores && r.decision
        ? {
            autoDecision: r.decision,
            scores,
            nsfw: nsfwScore(scores),
            labels: parse<Label[]>(r.labels ?? []),
            reasons: parse<Reason[]>(r.reasons ?? []),
            inferenceMs: Number(r.inference_ms ?? 0),
            model: r.model ?? "",
          }
        : null,
    image: { width: r.width, height: r.height, bytes: r.bytes_stored, metadataRemoved: r.exif_removed },
    timestamps: {
      created: iso(r.created_at)!,
      uploaded: iso(r.uploaded_at),
      processingStarted: iso(r.started_at),
      decided: iso(r.decided_at),
    },
  };
}

export type GalleryItem = { id: string; width: number | null; height: number | null; label: string | null; decidedAt: string };

export async function listApproved(db: Db, limit = 60): Promise<GalleryItem[]> {
  const rows = await db.query<{ id: string; width: number | null; height: number | null; labels: unknown; decided_at: Date | string }>(
    `SELECT i.id, i.width, i.height, r.labels, i.decided_at
       FROM image_moderation.images i
       LEFT JOIN image_moderation.moderation_results r ON r.image_id = i.id
      WHERE i.status = 'approved'
      ORDER BY i.decided_at DESC NULLS LAST
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => {
    const labels = parse<Label[] | null>(r.labels);
    return {
      id: r.id,
      width: r.width,
      height: r.height,
      label: labels?.[0]?.label ?? null,
      decidedAt: iso(r.decided_at)!,
    };
  });
}

export type ReviewItem = {
  id: string;
  policyId: string;
  createdAt: string;
  scores: Scores;
  reasons: Reason[];
  labels: Label[];
};

export async function listReviewQueue(db: Db, limit = 50): Promise<ReviewItem[]> {
  const rows = await db.query<{ id: string; policy_id: string; created_at: Date | string; scores: unknown; reasons: unknown; labels: unknown }>(
    `SELECT i.id, i.policy_id, i.created_at, r.scores, r.reasons, r.labels
       FROM image_moderation.images i
       JOIN image_moderation.moderation_results r ON r.image_id = i.id
      WHERE i.status = 'needs_review'
      ORDER BY i.created_at
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    policyId: r.policy_id,
    createdAt: iso(r.created_at)!,
    scores: parse<Scores>(r.scores),
    reasons: parse<Reason[]>(r.reasons),
    labels: parse<Label[]>(r.labels),
  }));
}

export type AuditEntry = {
  id: string;
  imageId: string | null;
  actor: string;
  action: string;
  from: string | null;
  to: string | null;
  note: string | null;
  details: Record<string, unknown>;
  at: string;
};

export async function listAudit(db: Db, { imageId, limit = 100 }: { imageId?: string; limit?: number } = {}): Promise<AuditEntry[]> {
  const rows = await db.query<{
    id: string;
    image_id: string | null;
    actor: string;
    action: string;
    from_status: string | null;
    to_status: string | null;
    note: string | null;
    details: unknown;
    created_at: Date | string;
  }>(
    `SELECT id::text, image_id, actor, action, from_status, to_status, note, details, created_at
       FROM image_moderation.audit_log
      WHERE ($1::uuid IS NULL OR image_id = $1::uuid)
      ORDER BY id DESC
      LIMIT $2`,
    [imageId ?? null, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    imageId: r.image_id,
    actor: r.actor,
    action: r.action,
    from: r.from_status,
    to: r.to_status,
    note: r.note,
    details: parse<Record<string, unknown>>(r.details ?? {}),
    at: iso(r.created_at)!,
  }));
}

export async function getStats(db: Db) {
  const rows = await db.query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM image_moderation.images GROUP BY status`,
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])) as Record<string, number>;
}
