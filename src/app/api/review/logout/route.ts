import { SESSION_COOKIE } from "@/lib/auth";
import { json } from "@/lib/http/respond";

export async function POST() {
  return json({ ok: true }, { headers: { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` } });
}
