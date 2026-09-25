import { getDb } from "@/lib/db";
import { json } from "@/lib/http/respond";

export async function GET() {
  const started = Date.now();
  try {
    await getDb().query("SELECT 1");
    return json({ ok: true, db: "up", ms: Date.now() - started });
  } catch {
    return json({ ok: false, db: "down" }, { status: 503 });
  }
}
