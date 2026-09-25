import { appDeps } from "@/lib/deps";
import { errorResponse, isUuid, json } from "@/lib/http/respond";
import { completeUpload } from "@/lib/services/uploads";

export const maxDuration = 30;

/**
 * POST /api/uploads/:id/complete
 * Verifies the uploaded bytes (size, magic bytes, decodable), strips
 * metadata, stores the clean copy, creates the moderation job and publishes
 * it to the queue. Returns 202: the decision happens asynchronously.
 */
export async function POST(_req: Request, ctx: RouteContext<"/api/uploads/[id]/complete">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "not_found" }, { status: 404 });
  try {
    const result = await completeUpload(appDeps(), id);
    return json(result, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
