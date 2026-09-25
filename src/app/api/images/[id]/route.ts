import { isReviewerRequest } from "@/lib/auth";
import { appDeps } from "@/lib/deps";
import { errorResponse, isUuid, json } from "@/lib/http/respond";
import { getImageStatus, listAudit } from "@/lib/services/queries";
import { republishIfStale } from "@/lib/services/republish";

/** GET /api/images/:id: job stage, decision, scores. Audit trail for reviewers. */
export async function GET(req: Request, ctx: RouteContext<"/api/images/[id]">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "not_found" }, { status: 404 });
  try {
    const deps = appDeps();
    const status = await getImageStatus(deps.db, id);
    if (!status) return json({ error: "not_found" }, { status: 404 });
    if (status.stage === "queued" && status.job) await republishIfStale(deps.db, deps.publisher, status.job.id);
    const audit = isReviewerRequest(req) ? await listAudit(deps.db, { imageId: id }) : undefined;
    return json({ ...status, audit });
  } catch (err) {
    return errorResponse(err);
  }
}
