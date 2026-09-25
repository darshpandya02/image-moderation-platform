import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";

export async function isReviewer(): Promise<boolean> {
  const jar = await cookies();
  return verifySession(jar.get(SESSION_COOKIE)?.value);
}
