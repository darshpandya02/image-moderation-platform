import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Classifier } from "@/lib/classifier";
import { createTfClassifier } from "@/lib/classifier/tf";
import { claimDueJobs, claimJob } from "@/lib/jobs/repo";
import type { Publisher } from "@/lib/queue";
import { getImageStatus, listApproved, listAudit, listReviewQueue } from "@/lib/services/queries";
import { reviewImage } from "@/lib/services/review";
import { completeUpload, createUpload, HttpError, type Deps } from "@/lib/services/uploads";
import { processJob, RetryLaterError, sweep, type WorkerDeps } from "@/lib/services/worker";
import { memoryBlobStore } from "@/lib/storage";
import { createTestDb } from "../helpers";

let db: Awaited<ReturnType<typeof createTestDb>>;
let classifier: Classifier;
const blob = memoryBlobStore();
const published: string[] = [];
const publisher: Publisher = {
  async publish(m) {
    published.push(m.jobId);
  },
};
const deps = (): Deps => ({ db, blob, publisher });
const workerDeps = (c: Classifier = classifier): WorkerDeps => ({ db, blob, classifier: async () => c });

let uploader = 0;
const nextUploader = () => `test-uploader-${++uploader}`;

async function photo(seed = 1): Promise<Buffer> {
  // A smooth synthetic landscape-like gradient, with EXIF attached.
  const w = 320;
  const h = 240;
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      px[i] = (x * seed) % 256;
      px[i + 1] = 90 + ((y * 2) % 120);
      px[i + 2] = 160 + ((x + y) % 90);
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } })
    .jpeg()
    .withExif({ IFD0: { Make: "IntegrationCam", Artist: "someone@example.com" } })
    .toBuffer();
}

/** Simulates the browser: reserve, PUT to storage, then complete. */
async function uploadViaApi(data: Buffer, opts: { policyId?: string; uploaderHash?: string } = {}) {
  const reservation = await createUpload(deps(), {
    uploaderHash: opts.uploaderHash ?? nextUploader(),
    size: data.byteLength,
    contentType: "image/jpeg",
    policyId: opts.policyId,
  });
  await blob.write(reservation.pathname, data, "image/jpeg");
  return completeUpload(deps(), reservation.imageId);
}

beforeAll(async () => {
  db = await createTestDb();
  classifier = await createTfClassifier();
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  published.length = 0;
});

describe("upload to decision", () => {
  it("moves an SFW upload through queued -> processing -> approved and shows it in the gallery", async () => {
    const { imageId, jobId } = await uploadViaApi(await photo());
    expect(jobId).toBeTruthy();
    expect(published).toEqual([jobId]);

    const queued = await getImageStatus(db, imageId);
    expect(queued?.stage).toBe("queued");
    expect(queued?.image.metadataRemoved).toBe(true);
    expect(await listApproved(db)).toHaveLength(0);

    // The stored object is the sanitized copy, and the raw upload is gone.
    const stored = [...blob.objects.keys()];
    expect(stored).toContain(`images/${imageId}.jpg`);
    expect(stored.some((k) => k.startsWith("incoming/"))).toBe(false);
    expect((await sharp(blob.objects.get(`images/${imageId}.jpg`)!.data).metadata()).exif).toBeUndefined();

    const outcome = await processJob(jobId!, workerDeps());
    expect(outcome).toEqual({ outcome: "completed", decision: "approved" });

    const decided = await getImageStatus(db, imageId);
    expect(decided?.stage).toBe("decided");
    expect(decided?.status).toBe("approved");
    expect(decided?.job?.status).toBe("completed");
    expect(decided?.result?.scores.neutral).toBeGreaterThan(0);
    expect(decided?.result?.labels.length).toBe(3);
    expect(decided?.result?.inferenceMs).toBeGreaterThanOrEqual(0);

    expect((await listApproved(db)).map((g) => g.id)).toContain(imageId);
    const audit = await listAudit(db, { imageId });
    expect(audit.map((a) => a.action).reverse()).toEqual(["uploaded", "auto_decision"]);
  });

  it("is idempotent under duplicate delivery and duplicate completion", async () => {
    const { imageId, jobId } = await uploadViaApi(await photo(2));
    const again = await completeUpload(deps(), imageId);
    expect(again.duplicate).toBe(true);
    expect(again.jobId).toBe(jobId);

    const first = await processJob(jobId!, workerDeps());
    const second = await processJob(jobId!, workerDeps());
    expect(first.outcome).toBe("completed");
    expect(second.outcome).toBe("already_done");

    const results = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM image_moderation.moderation_results WHERE image_id = $1`,
      [imageId],
    );
    expect(results[0]!.n).toBe(1);
    const decisions = (await listAudit(db, { imageId })).filter((a) => a.action === "auto_decision");
    expect(decisions).toHaveLength(1);
  });

  it("tells a concurrent duplicate to retry after the lease instead of double-processing", async () => {
    const { jobId } = await uploadViaApi(await photo(3));
    const claim = await claimJob(db, jobId!, 60);
    expect(claim.kind).toBe("claimed");
    await expect(processJob(jobId!, workerDeps())).rejects.toBeInstanceOf(RetryLaterError);
  });
});

describe("policy and human review", () => {
  it("routes to the reviewer queue under the strict demo policy, and the reviewer decision is audited", async () => {
    const { imageId, jobId } = await uploadViaApi(await photo(4), { policyId: "strict-demo" });
    expect((await processJob(jobId!, workerDeps())).outcome).toBe("completed");

    const status = await getImageStatus(db, imageId);
    expect(status?.status).toBe("needs_review");
    expect(status?.result?.reasons).toContainEqual(expect.objectContaining({ category: "sexy", rule: "review", threshold: 0 }));
    expect((await listReviewQueue(db)).map((r) => r.id)).toContain(imageId);
    expect((await listApproved(db)).map((g) => g.id)).not.toContain(imageId);

    const res = await reviewImage(db, { imageId, action: "approve", reviewer: "reviewer", note: "looks fine" });
    expect(res).toMatchObject({ from: "needs_review", to: "approved" });
    expect((await listReviewQueue(db)).map((r) => r.id)).not.toContain(imageId);
    expect((await listApproved(db)).map((g) => g.id)).toContain(imageId);

    const audit = await listAudit(db, { imageId });
    expect(audit[0]).toMatchObject({ action: "review_approve", from: "needs_review", to: "approved", actor: "reviewer", note: "looks fine" });

    // Re-applying the same decision is a conflict, reversing it is allowed and audited.
    await expect(reviewImage(db, { imageId, action: "approve", reviewer: "reviewer" })).rejects.toMatchObject({ status: 409 });
    await reviewImage(db, { imageId, action: "reject", reviewer: "reviewer" });
    expect((await getImageStatus(db, imageId))?.status).toBe("rejected");
    expect((await listAudit(db, { imageId })).filter((a) => a.action.startsWith("review_"))).toHaveLength(2);
  });

  it("rejects when a reject threshold is crossed", async () => {
    const hot: Classifier = {
      async classify() {
        return {
          scores: { drawing: 0, hentai: 0, neutral: 0.05, porn: 0.95, sexy: 0 },
          labels: [{ label: "test", probability: 1 }],
          model: "fixed-scores",
          inferenceMs: 1,
        };
      },
    };
    const { imageId, jobId } = await uploadViaApi(await photo(5));
    expect(await processJob(jobId!, workerDeps(hot))).toEqual({ outcome: "completed", decision: "rejected" });
    expect((await getImageStatus(db, imageId))?.status).toBe("rejected");
  });

  it("rejects an unknown policy and bad reviewer actions", async () => {
    await expect(
      createUpload(deps(), { uploaderHash: nextUploader(), size: 10, contentType: "image/jpeg", policyId: "nope" }),
    ).rejects.toMatchObject({ status: 400, code: "unknown_policy" });
    await expect(
      reviewImage(db, { imageId: "00000000-0000-0000-0000-000000000000", action: "approve", reviewer: "r" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(reviewImage(db, { imageId: "x", action: "delete", reviewer: "r" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("failures, retries and dead letters", () => {
  const broken: Classifier = {
    async classify() {
      throw new Error("model exploded");
    },
  };

  it("backs off, retries, and dead-letters after max attempts", async () => {
    const { imageId, jobId } = await uploadViaApi(await photo(6));
    for (let attempt = 1; attempt <= 3; attempt++) {
      const err = await processJob(jobId!, workerDeps(broken)).catch((e) => e);
      expect(err).toBeInstanceOf(RetryLaterError);
      const s = await getImageStatus(db, imageId);
      expect(s?.job).toMatchObject({ status: "retrying", attempts: attempt, lastError: "model exploded" });
      // Too early: the job is still backing off.
      await expect(processJob(jobId!, workerDeps(broken))).rejects.toThrow(/backing off/);
      await db.query(`UPDATE image_moderation.jobs SET next_attempt_at = now() WHERE id = $1`, [jobId]);
    }
    expect(await processJob(jobId!, workerDeps(broken))).toEqual({ outcome: "dead_letter" });
    const s = await getImageStatus(db, imageId);
    expect(s?.job?.status).toBe("dead_letter");
    expect(s?.status).toBe("failed");
    expect(s?.stage).toBe("failed");
    expect((await listAudit(db, { imageId })).map((a) => a.action)).toContain("dead_lettered");
    expect(await processJob(jobId!, workerDeps())).toEqual({ outcome: "already_done" });
  });

  it("recovers a job whose worker crashed, via the SKIP LOCKED sweeper", async () => {
    const { imageId, jobId } = await uploadViaApi(await photo(7));
    const claim = await claimJob(db, jobId!, 60);
    expect(claim.kind).toBe("claimed");
    // Simulate the worker dying: lease expires with the job still 'processing'.
    await db.query(`UPDATE image_moderation.jobs SET locked_until = now() - interval '1 second' WHERE id = $1`, [jobId]);

    const result = await sweep({ deps: workerDeps() });
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    const s = await getImageStatus(db, imageId);
    expect(s?.status).toBe("approved");
    expect(s?.job?.attempts).toBe(2);
  });

  it("a stale worker cannot overwrite the result of the attempt that replaced it", async () => {
    const { jobId } = await uploadViaApi(await photo(8));
    const first = await claimJob(db, jobId!, 60);
    await db.query(`UPDATE image_moderation.jobs SET locked_until = now() - interval '1 second' WHERE id = $1`, [jobId]);
    const second = await claimJob(db, jobId!, 60);
    expect(first.kind === "claimed" && second.kind === "claimed").toBe(true);
    if (first.kind !== "claimed" || second.kind !== "claimed") return;
    expect(second.job.attempts).toBe(first.job.attempts + 1);
    const { completeJob } = await import("@/lib/jobs/repo");
    const base = {
      jobId: jobId!,
      model: "m",
      scores: { drawing: 0, hentai: 0, neutral: 1, porn: 0, sexy: 0 },
      labels: [],
      reasons: [],
      policy: { id: "default", name: "Default", version: 1, thresholds: {} },
      inferenceMs: 1,
    };
    expect(await completeJob(db, { ...base, attempt: first.job.attempts, decision: "rejected" })).toBe(false);
    expect(await completeJob(db, { ...base, attempt: second.job.attempts, decision: "approved" })).toBe(true);
  });

  it("sweeper claims each due job exactly once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await uploadViaApi(await photo(10 + i))).jobId!);
    const [a, b] = await Promise.all([claimDueJobs(db, 3, 60), claimDueJobs(db, 3, 60)]);
    const claimed = [...a, ...b].map((j) => j.id).filter((id) => ids.includes(id));
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed.length).toBe(5);
  });
});

describe("upload validation and rate limiting", () => {
  it("rejects a non-image whose name and declared type claim JPEG", async () => {
    const r = await createUpload(deps(), { uploaderHash: nextUploader(), size: 100, contentType: "image/jpeg" });
    await blob.write(r.pathname, Buffer.from("#!/bin/sh\necho definitely not a jpeg\n"), "image/jpeg");
    await expect(completeUpload(deps(), r.imageId)).rejects.toMatchObject({ status: 415, code: "unsupported_type" });
    expect((await getImageStatus(db, r.imageId))?.status).toBe("failed");
    expect(blob.objects.has(r.pathname)).toBe(false);
  });

  it("rejects an upload that grew past 5 MB after the token was issued", async () => {
    const r = await createUpload(deps(), { uploaderHash: nextUploader(), size: 100, contentType: "image/jpeg" });
    const big = Buffer.alloc(5 * 1024 * 1024 + 10);
    big.set([0xff, 0xd8, 0xff]);
    await blob.write(r.pathname, big, "image/jpeg");
    await expect(completeUpload(deps(), r.imageId)).rejects.toMatchObject({ status: 413 });
  });

  it("requires the file to exist before completion", async () => {
    const r = await createUpload(deps(), { uploaderHash: nextUploader(), size: 100, contentType: "image/png" });
    await expect(completeUpload(deps(), r.imageId)).rejects.toMatchObject({ status: 409, code: "upload_missing" });
  });

  it("limits uploads per client and reports Retry-After", async () => {
    const who = nextUploader();
    const limit = Number(process.env.UPLOAD_RATE_LIMIT ?? 30);
    for (let i = 0; i < limit; i++) {
      await createUpload(deps(), { uploaderHash: who, size: 100, contentType: "image/jpeg" });
    }
    const err = await createUpload(deps(), { uploaderHash: who, size: 100, contentType: "image/jpeg" }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(429);
    expect(Number(err.headers["Retry-After"])).toBeGreaterThan(0);
    // Another client is unaffected.
    await expect(createUpload(deps(), { uploaderHash: nextUploader(), size: 100, contentType: "image/jpeg" })).resolves.toBeTruthy();
  });
});
