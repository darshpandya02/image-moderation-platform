"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/review/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setBusy(false);
    if (res.ok) router.refresh();
    else setError((await res.json().catch(() => ({}))).message ?? "login failed");
  }

  return (
    <form className="panel row" onSubmit={submit} data-testid="login-form">
      <input
        type="password"
        name="password"
        placeholder="Reviewer password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
      />
      <button className="primary" type="submit" disabled={busy || !password}>
        Sign in
      </button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await fetch("/api/review/logout", { method: "POST" });
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
