import { isReviewerRequest } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { errorResponse, isUuid, json, readJson } from "@/lib/http/respond";
import { reviewImage } from "@/lib/services/review";

/** POST /api/review/:id  { action: "approve" | "reject", note? }. Reviewer only, audited. */
export async function POST(req: Request, ctx: RouteContext<"/api/review/[id]">) {
  if (!isReviewerRequest(req)) return json({ error: "unauthorized" }, { status: 401 });
  // Same-origin check on top of the SameSite=Strict cookie.
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "not_found" }, { status: 404 });
  try {
    const body = await readJson(req);
    const result = await reviewImage(getDb(), { imageId: id, action: body.action, reviewer: "reviewer", note: body.note });
    return json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
