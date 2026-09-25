import { isReviewerRequest } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { errorResponse, json } from "@/lib/http/respond";
import { listReviewQueue } from "@/lib/services/queries";

/** GET /api/review/queue: images waiting for a human decision. Reviewer only. */
export async function GET(req: Request) {
  if (!isReviewerRequest(req)) return json({ error: "unauthorized" }, { status: 401 });
  try {
    return json({ items: await listReviewQueue(getDb()) });
  } catch (err) {
    return errorResponse(err);
  }
}
