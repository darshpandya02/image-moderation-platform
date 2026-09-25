import { checkPassword, createSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { errorResponse, json } from "@/lib/http/respond";
import { clientIp, hashIp, hitRateLimit, LOGIN_LIMIT } from "@/lib/ratelimit";
import { HttpError } from "@/lib/services/uploads";

/** POST /api/review/login  { password } -> sets the reviewer session cookie. */
export async function POST(req: Request) {
  try {
    const rl = await hitRateLimit(getDb(), `login:${hashIp(clientIp(req.headers))}`, LOGIN_LIMIT);
    if (!rl.allowed) throw new HttpError(429, "rate_limited", "too many login attempts");
    const form = req.headers.get("content-type")?.includes("application/json")
      ? ((await req.json()) as { password?: unknown })
      : Object.fromEntries((await req.formData()).entries());
    if (!checkPassword(form.password)) throw new HttpError(401, "bad_password", "wrong password");
    const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
    return json(
      { ok: true },
      {
        headers: {
          "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(createSession())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure}`,
        },
      },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
