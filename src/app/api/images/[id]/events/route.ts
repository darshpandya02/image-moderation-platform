import { appDeps } from "@/lib/deps";
import { isUuid, json } from "@/lib/http/respond";
import { getImageStatus } from "@/lib/services/queries";
import { republishIfStale } from "@/lib/services/republish";

export const maxDuration = 60;

const POLL_MS = 300;
const MAX_STREAM_MS = 55_000;

/**
 * GET /api/images/:id/events: Server-Sent Events. Emits a `status` event
 * whenever the stage or decision changes and closes once the image is
 * decided or failed. The server polls Postgres so the browser does not have
 * to; clients reconnect automatically if the stream ends early.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/images/[id]/events">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "not_found" }, { status: 404 });
  const deps = appDeps();
  const first = await getImageStatus(deps.db, id);
  if (!first) return json({ error: "not_found" }, { status: 404 });

  const encoder = new TextEncoder();
  const started = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let last = "";
      let closed = false;
      req.signal.addEventListener("abort", () => {
        closed = true;
      });
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      let status = first;
      controller.enqueue(encoder.encode("retry: 1000\n\n"));
      while (!closed) {
        const key = `${status.stage}:${status.status}:${status.job?.status}:${status.job?.attempts}`;
        if (key !== last) {
          send("status", status);
          last = key;
        }
        if (status.stage === "decided" || status.stage === "failed") break;
        if (Date.now() - started > MAX_STREAM_MS) break;
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (status.stage === "queued" && status.job) await republishIfStale(deps.db, deps.publisher, status.job.id);
        const next = await getImageStatus(deps.db, id).catch(() => null);
        if (!next) break;
        status = next;
      }
      if (!closed) {
        send("end", { stage: status.stage });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
