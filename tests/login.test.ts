import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_COOKIE, DEVICE_COOKIE } from "@/lib/auth";
import { createLoginHandler } from "@/lib/server/login-handler";
import { LOGIN_LIMITS } from "@/lib/server/login-throttle";
import { memoryStore, type SharedStore } from "@/lib/server/shared-store";

const PASSWORD = "correct horse battery";
let clock: number;
let store: SharedStore;

beforeEach(() => {
  vi.stubEnv("APP_MODE", "session");
  vi.stubEnv("APP_PASSWORD", PASSWORD);
  vi.stubEnv("TWELVELABS_API_KEY", "tlk_test_key");
  clock = Date.parse("2026-11-02T10:00:00Z");
  store = memoryStore(() => clock);
});
afterEach(() => vi.unstubAllEnvs());

function login(password: string, opts: { ip?: string; cookie?: string; body?: BodyInit; headers?: Record<string, string> } = {}) {
  return new Request("https://polbocus.vercel.app/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://polbocus.vercel.app", host: "polbocus.vercel.app", "x-real-ip": opts.ip ?? "203.0.113.7", ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
    body: opts.body ?? JSON.stringify({ password }),
    // @ts-expect-error Node needs this for streamed bodies
    duplex: "half",
  });
}

const deviceCookie = (response: Response) => response.headers.getSetCookie().find((c) => c.startsWith(`${DEVICE_COOKIE}=`))!.split(";")[0];

describe("login throttling", () => {
  it("counts concurrent attempts so they cannot bypass the per-source budget", async () => {
    const handler = createLoginHandler(() => store, { failureDelayMs: 0 });
    const responses = await Promise.all(Array.from({ length: 20 }, () => handler(login("wrong password!"))));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(LOGIN_LIMITS.perSource);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20 - LOGIN_LIMITS.perSource);
    const limited = responses.find((r) => r.status === 429)!;
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Even the right password is refused from that source until the cooldown ends.
    expect((await handler(login(PASSWORD))).status).toBe(429);
  });

  it("shares the budget between separate handler instances (serverless instances)", async () => {
    const a = createLoginHandler(() => store, { failureDelayMs: 0 });
    const b = createLoginHandler(() => store, { failureDelayMs: 0 });
    for (let i = 0; i < 3; i++) expect((await a(login("nope nope nope"))).status).toBe(401);
    for (let i = 0; i < 2; i++) expect((await b(login("nope nope nope"))).status).toBe(401);
    expect((await b(login("nope nope nope"))).status).toBe(429);
    expect((await a(login(PASSWORD))).status).toBe(429);
  });

  it("lets the owner sign in again after the cooldown", async () => {
    const handler = createLoginHandler(() => store, { failureDelayMs: 0 });
    for (let i = 0; i < LOGIN_LIMITS.perSource + 2; i++) await handler(login("guess guess guess"));
    expect((await handler(login(PASSWORD))).status).toBe(429);
    clock += LOGIN_LIMITS.windowMs + 1;
    const ok = await handler(login(PASSWORD));
    expect(ok.status).toBe(200);
    const cookies = ok.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith(`${AUTH_COOKIE}=`) && c.includes("HttpOnly") && c.includes("Secure") && c.includes("SameSite=Lax"))).toBe(true);
  });

  it("applies a global budget across sources, which a known device is not subject to", async () => {
    const handler = createLoginHandler(() => store, { failureDelayMs: 0 });
    const device = deviceCookie(await handler(login(PASSWORD, { ip: "198.51.100.1" })));
    for (let i = 0; i < LOGIN_LIMITS.global; i++) await handler(login("spray spray spray", { ip: `192.0.2.${i}` }));
    expect((await handler(login(PASSWORD, { ip: "192.0.2.250" }))).status).toBe(429); // new source, global budget spent
    expect((await handler(login(PASSWORD, { ip: "192.0.2.251", cookie: device }))).status).toBe(200); // owner's browser
  });

  it("does not trust a forged device cookie", async () => {
    const handler = createLoginHandler(() => store, { failureDelayMs: 0 });
    const forged = `${DEVICE_COOKIE}=${"a".repeat(32)}.${clock + 1e9}.forged`;
    for (let i = 0; i < LOGIN_LIMITS.perSource; i++) await handler(login("wrong wrong wrong", { cookie: forged }));
    expect((await handler(login(PASSWORD, { cookie: forged }))).status).toBe(429);
  });

  it("refuses oversized requests before buffering or hashing them", async () => {
    const handler = createLoginHandler(() => store, { failureDelayMs: 0 });
    const digest = vi.spyOn(crypto.subtle, "digest");
    const declared = await handler(login("", { body: JSON.stringify({ password: "x".repeat(10_000) }) }));
    expect(declared.status).toBe(413);
    // No Content-Length: counted while streaming.
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode("x".repeat(1000))); c.close(); } });
    expect((await handler(login("", { body: stream }))).status).toBe(413);
    expect(digest).not.toHaveBeenCalled();
    // A long password inside the body limit is rejected without hashing it.
    const long = await handler(login("y".repeat(1000)));
    expect(long.status).toBe(401);
    expect(digest.mock.calls.some(([, data]) => (data as Uint8Array).byteLength >= 1000)).toBe(false);
    digest.mockRestore();
  });

  it("fails closed when the shared store is unavailable or missing", async () => {
    const broken = { ...memoryStore(), hit: async () => { throw new Error("down"); } } as SharedStore;
    expect((await createLoginHandler(() => broken, { failureDelayMs: 0 })(login(PASSWORD))).status).toBe(503);
    expect((await createLoginHandler(() => null, { failureDelayMs: 0 })(login(PASSWORD))).status).toBe(503);
  });

  it("rejects cross-origin attempts and is absent in local mode", async () => {
    const handler = createLoginHandler(() => store, { failureDelayMs: 0 });
    expect((await handler(login(PASSWORD, { headers: { origin: "https://evil.example" } }))).status).toBe(403);
    vi.stubEnv("APP_MODE", "");
    vi.stubEnv("VERCEL", "");
    expect((await handler(login(PASSWORD))).status).toBe(404);
  });
});
