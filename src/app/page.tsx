import Link from "next/link";
import { Uploader } from "@/components/Uploader";
import { getDb } from "@/lib/db";
import { listPolicies } from "@/lib/services/policies";
import { getStats, listApproved } from "@/lib/services/queries";

export const dynamic = "force-dynamic";

export default async function Home() {
  const db = getDb();
  const [policies, images, stats] = await Promise.all([listPolicies(db), listApproved(db, 48), getStats(db)]);
  return (
    <>
      <h1>Image moderation</h1>
      <p className="lead">
        Upload an image. It goes to private object storage, a moderation job is queued, and a worker runs an
        open-source NSFW classifier on it. A policy with per-category thresholds approves it, rejects it, or sends it to a
        human reviewer. Only approved images show up below.
      </p>
      <Uploader policies={policies.map((p) => ({ id: p.id, name: p.name, description: p.description }))} />

      <h2>
        Gallery <span className="muted" style={{ fontWeight: 400, fontSize: "0.9rem" }}>
          {stats.approved ?? 0} approved, {stats.needs_review ?? 0} awaiting review, {stats.rejected ?? 0} rejected
        </span>
      </h2>
      {images.length === 0 ? (
        <p className="muted">Nothing approved yet.</p>
      ) : (
        <div className="grid" data-testid="gallery">
          {images.map((img) => (
            <Link key={img.id} href={`/images/${img.id}`} className="card" data-image-id={img.id}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/images/${img.id}/file`} alt={img.label ?? "approved image"} loading="lazy" />
              <div className="meta">{img.label ?? "unlabelled"}</div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
