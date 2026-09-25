import { createHash } from "node:crypto";
import type { Db } from "@/lib/db";

export type RateLimitResult = { allowed: boolean; hits: number; limit: number; resetAt: Date };

/**
 * Fixed-window counter in Postgres. One upsert per request, so it is atomic
 * across concurrent function instances without an extra cache service.
 */
export async function hitRateLimit(
  db: Db,
  bucket: string,
  { limit, windowSeconds }: { limit: number; windowSeconds: number },
  now = new Date(),
): Promise<RateLimitResult> {
  const windowStartMs = Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000;
  const windowStart = new Date(windowStartMs);
  const rows = await db.query<{ hits: number }>(
    `INSERT INTO image_moderation.rate_limits (bucket, window_start, hits)
     VALUES ($1, $2, 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET hits = image_moderation.rate_limits.hits + 1
     RETURNING hits`,
    [bucket, windowStart.toISOString()],
  );
  const hits = Number(rows[0]?.hits ?? 1);
  // Opportunistic cleanup of old windows, roughly 1 in 50 requests.
  if (Math.random() < 0.02) {
    await db.query(`DELETE FROM image_moderation.rate_limits WHERE window_start < now() - interval '1 day'`);
  }
  return {
    allowed: hits <= limit,
    hits,
    limit,
    resetAt: new Date(windowStartMs + windowSeconds * 1000),
  };
}

export function clientIp(headers: Headers): string {
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return "unknown";
}

/** IPs are never stored raw; only a salted hash is kept. */
export function hashIp(ip: string): string {
  const salt = process.env.SESSION_SECRET ?? "local-dev-salt";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

export const UPLOAD_LIMIT = {
  limit: Number(process.env.UPLOAD_RATE_LIMIT ?? 30),
  windowSeconds: Number(process.env.UPLOAD_RATE_WINDOW_SECONDS ?? 600),
};

export const LOGIN_LIMIT = { limit: 10, windowSeconds: 600 };
