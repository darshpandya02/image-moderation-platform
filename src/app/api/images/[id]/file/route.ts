import { isReviewerRequest } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isUuid, json } from "@/lib/http/respond";
import { getBlobStore } from "@/lib/storage";

/**
 * GET /api/images/:id/file: streams the stored image from the private store.
 * Anyone can fetch approved images; everything else requires a reviewer
 * session, so rejected or pending content is never publicly reachable.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/images/[id]/file">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "not_found" }, { status: 404 });
  const rows = await getDb().query<{ status: string; blob_path: string | null }>(
    `SELECT status, blob_path FROM image_moderation.images WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row?.blob_path) return json({ error: "not_found" }, { status: 404 });
  const reviewer = isReviewerRequest(req);
  if (row.status !== "approved" && !reviewer) return json({ error: "not_found" }, { status: 404 });

  const obj = await getBlobStore().stream(row.blob_path);
  if (!obj) return json({ error: "not_found" }, { status: 404 });
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.contentType,
      "Cache-Control": row.status === "approved" && !reviewer ? "public, max-age=300" : "private, no-store",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}
