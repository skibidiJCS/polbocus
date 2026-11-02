"use client";

import { useState } from "react";

export function LoginForm() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) }).catch(() => null);
    if (response?.ok) {
      window.location.replace("/");
      return;
    }
    const body = (await response?.json().catch(() => ({}))) as { error?: string } | undefined;
    setError(body?.error ?? "Couldn’t reach the server.");
    setBusy(false);
  }

  return (
    <form className="login-form" onSubmit={submit}>
      <label htmlFor="password" className="sr-only">Password</label>
      <input id="password" className="field" type="password" placeholder="Password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus />
      {error && <p className="inline-error" role="alert">{error}</p>}
      <button className="btn btn-primary btn-block" disabled={busy || !password}>{busy ? "Checking…" : "Continue"}</button>
    </form>
  );
}
