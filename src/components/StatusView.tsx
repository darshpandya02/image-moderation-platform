"use client";

import { useEffect, useState } from "react";
import type { ImageStatus } from "@/lib/services/queries";
import { ScoreBars } from "./ScoreBars";

const STEPS = ["queued", "processing", "decided"] as const;

function stepClass(step: (typeof STEPS)[number], stage: ImageStatus["stage"]) {
  const order = { uploading: -1, queued: 0, processing: 1, decided: 2, failed: 2 } as const;
  const i = STEPS.indexOf(step);
  const cur = order[stage];
  if (i < cur || (i === cur && stage === "decided")) return "step done";
  if (i === cur) return "step active";
  return "step";
}

export function StatusView({ initial }: { initial: ImageStatus }) {
  const [status, setStatus] = useState(initial);
  const [transport, setTransport] = useState<"sse" | "polling">("sse");

  useEffect(() => {
    if (initial.stage === "decided" || initial.stage === "failed") return;
    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const done = (s: ImageStatus) => s.stage === "decided" || s.stage === "failed";

    const poll = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`/api/images/${initial.id}`, { cache: "no-store" });
        if (res.ok) {
          const s = (await res.json()) as ImageStatus;
          setStatus(s);
          if (done(s)) return;
        }
      } catch {}
      pollTimer = setTimeout(poll, 1000);
    };

    const es = new EventSource(`/api/images/${initial.id}/events`);
    es.addEventListener("status", (e) => {
      const s = JSON.parse((e as MessageEvent).data) as ImageStatus;
      setStatus(s);
      if (done(s)) es.close();
    });
    es.addEventListener("end", () => es.close());
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED && !stopped) {
        setTransport("polling");
        void poll();
      }
    };
    return () => {
      stopped = true;
      es.close();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [initial.id, initial.stage]);

  const decision = status.status;
  const created = new Date(status.timestamps.created).getTime();
  const decidedAt = status.timestamps.decided ? new Date(status.timestamps.decided).getTime() : null;

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          Stage: <strong data-testid="stage">{status.stage}</strong>{" "}
          {status.stage === "decided" && (
            <span className={`badge ${decision}`} data-testid="decision">
              {decision}
            </span>
          )}
          {status.stage === "failed" && <span className="badge failed" data-testid="decision">failed</span>}
        </div>
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          live via {transport === "sse" ? "server-sent events" : "polling"}
        </span>
      </div>
      <div className="timeline">
        {STEPS.map((s) => (
          <span key={s} className={stepClass(s, status.stage)}>
            {s}
          </span>
        ))}
      </div>

      {status.job && (
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Job <code>{status.job.id.slice(0, 8)}</code> is <code>{status.job.status}</code>, attempt {status.job.attempts}
          {status.job.lastError ? ` (last error: ${status.job.lastError})` : ""}. Policy <code>{status.policyId}</code>.
          {decidedAt ? ` Decided ${((decidedAt - created) / 1000).toFixed(1)} s after the upload was reserved.` : ""}
        </p>
      )}

      {status.result && (
        <>
          <h2>Classifier output</h2>
          <ScoreBars scores={status.result.scores} />
          <p style={{ marginTop: "0.8rem" }}>
            General label:{" "}
            <strong data-testid="label">{status.result.labels[0]?.label ?? "n/a"}</strong>{" "}
            <span className="muted">({((status.result.labels[0]?.probability ?? 0) * 100).toFixed(1)}%)</span>
          </p>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Automatic decision: <code>{status.result.autoDecision}</code>
            {status.result.reasons.length > 0 &&
              ` because ${status.result.reasons
                .map((r) => `${r.category} ${(r.score * 100).toFixed(1)}% >= ${r.rule} threshold ${(r.threshold * 100).toFixed(0)}%`)
                .join("; ")}`}
            . Inference {status.result.inferenceMs} ms on <code>{status.result.model}</code>.
          </p>
        </>
      )}

      {status.status === "approved" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/images/${status.id}/file`} alt="approved upload" style={{ maxWidth: "100%", maxHeight: 420, borderRadius: 8, marginTop: "0.8rem" }} />
      ) : status.stage === "decided" ? (
        <p className="muted">The image is hidden because it is not approved{decision === "needs_review" ? " yet; a reviewer will look at it" : ""}.</p>
      ) : null}
    </div>
  );
}
