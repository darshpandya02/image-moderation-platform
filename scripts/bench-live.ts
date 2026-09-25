/**
 * Measures end-to-end moderation latency against a live deployment.
 *
 *   npx tsx scripts/bench-live.ts <base-url> <image-dir> [count]
 *
 * For each image, sequentially: reserve (POST /api/uploads), upload the bytes
 * straight to Blob with the issued token, complete (POST .../complete), then
 * poll GET /api/images/:id every 100 ms until the stage is "decided".
 * End-to-end = reserve start -> decision observed by the client.
 * Server-side splits come from the timestamps stored with each job.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { put } from "@vercel/blob/client";

const [base = "", dir = "", countArg = "25"] = process.argv.slice(2);
if (!base || !dir) {
  console.error("usage: tsx scripts/bench-live.ts <base-url> <image-dir> [count]");
  process.exit(1);
}
const count = Number(countArg);

type Sample = {
  file: string;
  bytes: number;
  decision: string;
  e2eMs: number;
  reserveMs: number;
  blobPutMs: number;
  completeMs: number;
  afterCompleteMs: number;
  serverQueueWaitMs: number;
  serverProcessMs: number;
  inferenceMs: number;
};

async function post(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

function pct(values: number[], p: number) {
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}

async function main() {
  const files = (await readdir(dir)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort().slice(0, count);
  const samples: Sample[] = [];
  for (const file of files) {
    const data = await readFile(path.join(dir, file));
    const t0 = performance.now();
    const r = await post(`${base}/api/uploads`, { size: data.byteLength, contentType: "image/jpeg", policyId: "default" });
    const t1 = performance.now();
    await put(r.pathname, data, { access: "private", token: r.clientToken, contentType: "image/jpeg" });
    const t2 = performance.now();
    await post(`${base}/api/uploads/${r.imageId}/complete`);
    const t3 = performance.now();
    let status;
    for (;;) {
      const res = await fetch(`${base}/api/images/${r.imageId}`, { cache: "no-store" });
      status = await res.json();
      if (status.stage === "decided" || status.stage === "failed") break;
      if (performance.now() - t0 > 120_000) throw new Error(`timeout on ${file}`);
      await new Promise((res) => setTimeout(res, 100));
    }
    const t4 = performance.now();
    const ts = status.timestamps;
    const s: Sample = {
      file,
      bytes: data.byteLength,
      decision: status.status,
      e2eMs: Math.round(t4 - t0),
      reserveMs: Math.round(t1 - t0),
      blobPutMs: Math.round(t2 - t1),
      completeMs: Math.round(t3 - t2),
      afterCompleteMs: Math.round(t4 - t3),
      serverQueueWaitMs: new Date(ts.processingStarted).getTime() - new Date(ts.uploaded).getTime(),
      serverProcessMs: new Date(ts.decided).getTime() - new Date(ts.processingStarted).getTime(),
      inferenceMs: status.result?.inferenceMs ?? -1,
    };
    samples.push(s);
    console.log(
      `${file.padEnd(10)} ${s.decision.padEnd(13)} e2e=${s.e2eMs}ms reserve=${s.reserveMs} put=${s.blobPutMs} complete=${s.completeMs} wait=${s.afterCompleteMs} | server queue=${s.serverQueueWaitMs} process=${s.serverProcessMs} infer=${s.inferenceMs}`,
    );
  }

  const keys = ["e2eMs", "reserveMs", "blobPutMs", "completeMs", "afterCompleteMs", "serverQueueWaitMs", "serverProcessMs", "inferenceMs"] as const;
  const summary = Object.fromEntries(
    keys.map((k) => {
      const v = samples.map((s) => s[k]);
      return [k, { p50: pct(v, 50), p95: pct(v, 95), min: Math.min(...v), max: Math.max(...v) }];
    }),
  );
  const decisions = samples.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.decision]: (acc[s.decision] ?? 0) + 1 }), {});
  const out = { base, measuredAt: new Date().toISOString(), n: samples.length, decisions, summary, samples };
  console.log(JSON.stringify({ n: out.n, decisions, summary }, null, 2));
  await writeFile("bench/live-latency.json", JSON.stringify(out, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
