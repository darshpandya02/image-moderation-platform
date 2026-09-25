import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Reviewer sessions: a single shared password (REVIEWER_PASSWORD) exchanged
 * for an HMAC-signed, expiring, httpOnly cookie. Stateless, so any function
 * instance can verify it.
 */
export const SESSION_COOKIE = "reviewer_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production" && process.env.VERCEL) {
    throw new Error("SESSION_SECRET must be set (16+ chars)");
  }
  return "local-development-session-secret";
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function checkPassword(candidate: unknown): boolean {
  const expected = process.env.REVIEWER_PASSWORD;
  if (!expected || typeof candidate !== "string") return false;
  // Compare HMACs so the comparison is constant-time regardless of length.
  return safeEqual(sign(`pw:${candidate}`), sign(`pw:${expected}`));
}

export function createSession(now = Date.now()): string {
  const exp = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const payload = `reviewer.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySession(token: string | undefined | null, now = Date.now()): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "reviewer") return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp * 1000 < now) return false;
  return safeEqual(parts[2]!, sign(`${parts[0]}.${parts[1]}`));
}

export function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function isReviewerRequest(req: Request): boolean {
  return verifySession(readSessionCookie(req.headers.get("cookie")));
}
