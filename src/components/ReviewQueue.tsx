"use client";

import { useState } from "react";
import type { ReviewItem } from "@/lib/services/queries";
import { ScoreBars } from "./ScoreBars";

export function ReviewQueue({ items: initial }: { items: ReviewItem[] }) {
  const [items, setItems] = useState(initial);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function act(id: string, action: "approve" | "reject") {
    setError(null);
    const res = await fetch(`/api/review/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, note: notes[id] ?? "" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.message ?? `failed (${res.status})`);
      return;
    }
    setDone((d) => ({ ...d, [id]: data.to }));
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 1500);
  }

  if (items.length === 0) return <p className="muted" data-testid="queue-empty">The review queue is empty.</p>;
  return (
    <div data-testid="review-queue">
      {error && <p className="error">{error}</p>}
      {items.map((item) => (
        <div key={item.id} className="panel review-item" style={{ marginBottom: "0.8rem" }} data-review-id={item.id}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/images/${item.id}/file`} alt="flagged upload" />
          <div>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <a href={`/images/${item.id}`} className="mono">
                {item.id.slice(0, 8)}
              </a>
              <span className="muted" style={{ fontSize: "0.8rem" }}>
                policy {item.policyId} · {new Date(item.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Flagged by:{" "}
              {item.reasons.map((r) => `${r.category} ${(r.score * 100).toFixed(1)}% >= ${(r.threshold * 100).toFixed(0)}%`).join(", ")}
              {" · "}label: {item.labels[0]?.label ?? "n/a"}
            </p>
            <ScoreBars scores={item.scores} />
            {done[item.id] ? (
              <p>
                Marked <span className={`badge ${done[item.id]}`} data-testid="review-result">{done[item.id]}</span>
              </p>
            ) : (
              <div className="row" style={{ marginTop: "0.8rem" }}>
                <input
                  type="text"
                  placeholder="Note (optional, saved in the audit log)"
                  value={notes[item.id] ?? ""}
                  onChange={(e) => setNotes((n) => ({ ...n, [item.id]: e.target.value }))}
                  style={{ flex: 1, minWidth: 200 }}
                />
                <button className="approve" onClick={() => act(item.id, "approve")}>
                  Approve
                </button>
                <button className="reject" onClick={() => act(item.id, "reject")}>
                  Reject
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
