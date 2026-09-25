"use client";

import { put } from "@vercel/blob/client";
import { useRouter } from "next/navigation";
import { useState } from "react";

const MAX_BYTES = 5 * 1024 * 1024;

type PolicyOption = { id: string; name: string; description: string };

async function postJson(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `request failed (${res.status})`);
  return data;
}

export function Uploader({ policies }: { policies: PolicyOption[] }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [policyId, setPolicyId] = useState(policies[0]?.id ?? "default");
  const [phase, setPhase] = useState<"idle" | "reserving" | "uploading" | "verifying">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setError(null);
    if (file.size > MAX_BYTES) {
      setError("File is larger than 5 MB.");
      return;
    }
    try {
      setPhase("reserving");
      const reservation = await postJson("/api/uploads", {
        size: file.size,
        contentType: file.type,
        policyId,
      });
      setPhase("uploading");
      await put(reservation.pathname, file, {
        access: "private",
        token: reservation.clientToken,
        contentType: file.type,
      });
      setPhase("verifying");
      await postJson(`/api/uploads/${reservation.imageId}/complete`);
      router.push(`/images/${reservation.imageId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  }

  const busy = phase !== "idle";
  const selected = policies.find((p) => p.id === policyId);
  return (
    <form className="panel" onSubmit={submit} data-testid="upload-form">
      <div className="row">
        <input
          type="file"
          name="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={busy}
        />
        <label className="row" style={{ gap: "0.4rem" }}>
          <span className="muted">Policy</span>
          <select name="policy" value={policyId} onChange={(e) => setPolicyId(e.target.value)} disabled={busy}>
            {policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary" disabled={!file || busy}>
          {phase === "idle" ? "Upload" : phase === "uploading" ? "Uploading..." : phase === "verifying" ? "Verifying..." : "Starting..."}
        </button>
      </div>
      {selected && <p className="muted" style={{ margin: "0.6rem 0 0", fontSize: "0.85rem" }}>{selected.description}</p>}
      <p className="muted" style={{ margin: "0.3rem 0 0", fontSize: "0.85rem" }}>
        JPEG, PNG or WebP up to 5 MB. Metadata (EXIF, GPS) is removed before storage.
      </p>
      {error && (
        <p className="error" role="alert" data-testid="upload-error">
          {error}
        </p>
      )}
    </form>
  );
}
