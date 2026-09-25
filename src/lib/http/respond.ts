import { HttpError } from "@/lib/services/uploads";

export function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, {
    ...init,
    headers: { "Cache-Control": "no-store", ...(init.headers ?? {}) },
  });
}

export function errorResponse(err: unknown) {
  if (err instanceof HttpError) {
    return json({ error: err.code, message: err.message }, { status: err.status, headers: err.headers });
  }
  console.error(err);
  return json({ error: "internal", message: "internal error" }, { status: 500 });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "bad_json", "request body must be JSON");
  }
}

export function isUuid(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
