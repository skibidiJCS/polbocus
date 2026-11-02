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
      <label htmlFor="password">Password</label>
      <div className="login-line">
        <input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus />
        <button className="button-solid" disabled={busy || !password}>{busy ? "Checking…" : "Sign in"}</button>
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <p className="login-fine">Only the owner of this site can sign in. Videos you search are deleted when you leave the page.</p>
    </form>
  );
}
