import { getDb } from "@/lib/db";
import { errorResponse, json } from "@/lib/http/respond";
import { listApproved } from "@/lib/services/queries";

/** GET /api/images: the public gallery, approved images only. */
export async function GET() {
  try {
    return json({ images: await listApproved(getDb()) });
  } catch (err) {
    return errorResponse(err);
  }
}
