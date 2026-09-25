import { json } from "@/lib/http/respond";
import { sweep } from "@/lib/services/worker";

export const maxDuration = 120;

/**
 * GET /api/cron/sweep: the Postgres pull path. Claims due, retrying or
 * abandoned jobs with FOR UPDATE SKIP LOCKED and runs them, dead-letters
 * exhausted ones and removes abandoned reservations. Triggered by Vercel Cron
 * (Authorization: Bearer CRON_SECRET).
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await sweep({ limit: 25 });
  return json(result);
}
