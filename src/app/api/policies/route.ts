import { getDb } from "@/lib/db";
import { errorResponse, json } from "@/lib/http/respond";
import { listPolicies } from "@/lib/services/policies";

export async function GET() {
  try {
    return json({ policies: await listPolicies(getDb()) });
  } catch (err) {
    return errorResponse(err);
  }
}
