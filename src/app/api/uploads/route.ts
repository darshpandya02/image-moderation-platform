import { appDeps } from "@/lib/deps";
import { errorResponse, json, readJson } from "@/lib/http/respond";
import { clientIp, hashIp } from "@/lib/ratelimit";
import { createUpload } from "@/lib/services/uploads";

/**
 * POST /api/uploads  { size, contentType, policyId? }
 * Reserves an image id and returns a client token that can write exactly one
 * private Blob pathname (max 5 MB, JPEG/PNG/WebP). Rate limited per IP.
 */
export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const result = await createUpload(appDeps(), {
      uploaderHash: hashIp(clientIp(req.headers)),
      size: body.size,
      contentType: body.contentType,
      policyId: body.policyId,
    });
    return json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
