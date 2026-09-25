import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db";
import { sanitizeImage } from "@/lib/images/sanitize";
import { assertDeclaredUpload, MAX_UPLOAD_BYTES, UploadRejectedError } from "@/lib/images/validate";
import type { Publisher } from "@/lib/queue";
import { hitRateLimit, UPLOAD_LIMIT } from "@/lib/ratelimit";
import type { BlobStore } from "@/lib/storage";
import { getDefaultPolicyId, getPolicy } from "./policies";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export type Deps = { db: Db; blob: BlobStore; publisher: Publisher };

/**
 * Step 1: reserve an image id and hand the browser a token that can write
 * exactly one pathname, at most 5 MB, of an allowed image type.
 */
export async function createUpload(
  deps: Deps,
  input: { uploaderHash: string; size: unknown; contentType: unknown; policyId?: unknown },
) {
  const rl = await hitRateLimit(deps.db, `upload:${input.uploaderHash}`, UPLOAD_LIMIT);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000));
    throw new HttpError(429, "rate_limited", `upload limit of ${rl.limit} per ${UPLOAD_LIMIT.windowSeconds}s reached`, {
      "Retry-After": String(retryAfter),
    });
  }
  try {
    assertDeclaredUpload(input.size, input.contentType);
  } catch (e) {
    if (e instanceof UploadRejectedError) throw new HttpError(e.httpStatus, e.code, e.message);
    throw e;
  }

  const policyId =
    typeof input.policyId === "string" && input.policyId.length > 0 ? input.policyId : await getDefaultPolicyId(deps.db);
  if (!(await getPolicy(deps.db, policyId))) throw new HttpError(400, "unknown_policy", `unknown policy "${policyId}"`);

  const imageId = randomUUID();
  const incomingPath = `incoming/${imageId}`;
  await deps.db.query(
    `INSERT INTO image_moderation.images (id, status, policy_id, incoming_path, uploader_hash)
     VALUES ($1, 'awaiting_upload', $2, $3, $4)`,
    [imageId, policyId, incomingPath, input.uploaderHash],
  );
  const clientToken = await deps.blob.issueUploadToken(incomingPath);
  return { imageId, pathname: incomingPath, clientToken, maxBytes: MAX_UPLOAD_BYTES };
}

type ImageRow = { id: string; status: string; incoming_path: string; policy_id: string };

/**
 * Step 2: after the browser finished writing to Blob, verify what actually
 * arrived (size, magic bytes, decodability), re-encode it without metadata,
 * then atomically flip the image to pending, create the job and publish it.
 * Calling it twice is harmless: only the first call moves awaiting_upload.
 */
export async function completeUpload(deps: Deps, imageId: string) {
  const rows = await deps.db.query<ImageRow & { job_id: string | null }>(
    `SELECT i.id, i.status, i.incoming_path, i.policy_id, j.id AS job_id
       FROM image_moderation.images i
       LEFT JOIN image_moderation.jobs j ON j.image_id = i.id
      WHERE i.id = $1`,
    [imageId],
  );
  const image = rows[0];
  if (!image) throw new HttpError(404, "not_found", "unknown image");
  if (image.status !== "awaiting_upload") {
    return { imageId, jobId: image.job_id, status: image.status, duplicate: true };
  }

  const raw = await deps.blob.read(image.incoming_path, MAX_UPLOAD_BYTES);
  if (!raw) throw new HttpError(409, "upload_missing", "no uploaded file found for this image");

  let clean;
  try {
    clean = await sanitizeImage(raw);
  } catch (e) {
    if (e instanceof UploadRejectedError) {
      await deps.blob.remove(image.incoming_path).catch(() => undefined);
      await deps.db.query(
        `WITH i AS (
           UPDATE image_moderation.images SET status = 'failed', updated_at = now()
            WHERE id = $1 AND status = 'awaiting_upload' RETURNING id
         )
         INSERT INTO image_moderation.audit_log (image_id, actor, action, from_status, to_status, details)
         SELECT id, 'system:upload', 'upload_rejected', 'awaiting_upload', 'failed', jsonb_build_object('code', $2::text)
           FROM i`,
        [imageId, e.code],
      );
      throw new HttpError(e.httpStatus, e.code, e.message);
    }
    throw e;
  }

  const blobPath = `images/${imageId}.${clean.kind.ext}`;
  await deps.blob.write(blobPath, clean.data, clean.kind.mime);

  const jobId = randomUUID();
  const updated = await deps.db.query<{ job_id: string }>(
    `WITH i AS (
        UPDATE image_moderation.images
           SET status = 'pending', blob_path = $2, content_type = $3, bytes_original = $4, bytes_stored = $5,
               width = $6, height = $7, sha256 = $8, exif_removed = $9, uploaded_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'awaiting_upload'
         RETURNING id
      ), j AS (
        INSERT INTO image_moderation.jobs (id, image_id, status) SELECT $10, id, 'queued' FROM i
        RETURNING id
      ), a AS (
        INSERT INTO image_moderation.audit_log (image_id, actor, action, from_status, to_status, details)
        SELECT id, 'system:upload', 'uploaded', 'awaiting_upload', 'pending',
               jsonb_build_object('bytes', $5::int, 'width', $6::int, 'height', $7::int, 'metadata_removed', $9::boolean)
          FROM i
        RETURNING id
      )
      SELECT id AS job_id FROM j`,
    [
      imageId,
      blobPath,
      clean.kind.mime,
      clean.bytesOriginal,
      clean.data.byteLength,
      clean.width,
      clean.height,
      clean.sha256,
      clean.hadMetadata,
      jobId,
    ],
  );
  await deps.blob.remove(image.incoming_path).catch(() => undefined);

  if (!updated[0]) {
    // Lost a race with a concurrent completion; that call owns the job.
    const again = await deps.db.query<{ job_id: string | null; status: string }>(
      `SELECT i.status, j.id AS job_id FROM image_moderation.images i
         LEFT JOIN image_moderation.jobs j ON j.image_id = i.id WHERE i.id = $1`,
      [imageId],
    );
    return { imageId, jobId: again[0]?.job_id ?? null, status: again[0]?.status ?? "pending", duplicate: true };
  }

  try {
    await deps.publisher.publish({ jobId }, jobId);
  } catch (err) {
    // The job row is already durable; the stale-job republisher and the sweeper will pick it up.
    console.error("publish failed, job left queued", jobId, err);
  }
  return { imageId, jobId, status: "pending", duplicate: false };
}
