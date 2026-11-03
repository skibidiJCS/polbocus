import "server-only";
import type { SharedStore } from "./shared-store";

/**
 * Sign-in attempt budgets, counted in the shared store so every serverless instance
 * enforces the same limits. Each attempt is counted before the password is checked, so
 * concurrent requests cannot slip past a budget.
 *
 * - A browser that signed in before (device cookie) has its own budget and skips the
 *   others, so attackers cannot lock the owner out of a known device.
 * - Everyone else is limited per source address and, together, by a global budget.
 * All budgets are fixed windows that reset by themselves; nothing locks permanently.
 */
export const LOGIN_LIMITS = {
  windowMs: 15 * 60_000,
  perDevice: 10,
  perSource: 5,
  global: 30,
} as const;

export type ThrottleDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The client address as Vercel reports it. Vercel sets these headers itself; elsewhere
 * they can be spoofed, which only moves an attacker into the shared global budget.
 */
export function clientAddress(request: Request) {
  return request.headers.get("x-real-ip")?.trim() || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function checkLoginAttempt(store: SharedStore, input: { deviceId: string | null; address: string }): Promise<ThrottleDecision> {
  const { windowMs } = LOGIN_LIMITS;
  const buckets = input.deviceId
    ? [{ key: `login:device:${input.deviceId}`, limit: LOGIN_LIMITS.perDevice }]
    : [
        { key: `login:source:${await digest(input.address)}`, limit: LOGIN_LIMITS.perSource },
        { key: "login:global", limit: LOGIN_LIMITS.global },
      ];
  let wait = 0;
  for (const bucket of buckets) {
    const { count, resetInMs } = await store.hit(bucket.key, windowMs);
    if (count > bucket.limit) wait = Math.max(wait, resetInMs);
  }
  return wait > 0 ? { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) } : { allowed: true };
}

/** A correct password clears this browser's own budget (never the global one). */
export async function clearLoginAttempts(store: SharedStore, input: { deviceId: string | null; address: string }) {
  await store.del(input.deviceId ? `login:device:${input.deviceId}` : `login:source:${await digest(input.address)}`);
}
