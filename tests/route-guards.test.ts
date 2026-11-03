import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every dependency that touches private state is a spy; rejected requests must not reach any.
const getSessionDeps = vi.fn(() => { throw new Error("session deps must not be reached"); });
const getDb = vi.fn(() => { throw new Error("database must not be reached"); });
const getWorker = vi.fn(() => { throw new Error("worker must not be reached"); });
const getProvider = vi.fn(() => { throw new Error("provider must not be reached"); });
vi.mock("@/lib/server/session-runtime", () => ({ getSessionDeps, processDueOpportunistically: vi.fn(), sessionSettings: {} }));
vi.mock("@/lib/server/db", async (original) => ({ ...(await original<object>()), getDb }));
vi.mock("@/lib/server/runtime", () => ({ getWorker, getProvider }));

const { AUTH_COOKIE, createSessionToken } = await import("@/lib/auth");
const sessionRoutes = {
  start: (await import("@/app/api/session/start/route")).POST,
  status: (await import("@/app/api/session/status/route")).POST,
  search: (await import("@/app/api/session/search/route")).POST,
  end: (await import("@/app/api/session/end/route")).POST,
  heartbeat: (await import("@/app/api/session/heartbeat/route")).POST,
  upload: (await import("@/app/api/session/upload/route")).POST,
};
const videosGET = (await import("@/app/api/videos/route")).GET;
const setupGET = (await import("@/app/api/setup/route")).GET;
const cronGET = (await import("@/app/api/cron/cleanup/route")).GET;

const SID = "0b5e8c3a-4f1e-4a8a-9d3e-2c1f0e9b7a6d";
const post = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", host: new URL(url).host, ...headers }, body: JSON.stringify({ sessionId: SID }) });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("hosted-only routes outside hosted mode", () => {
  beforeEach(() => {
    vi.stubEnv("APP_MODE", "");
    vi.stubEnv("VERCEL", "");
  });

  it("answer 404 before touching Blob, TwelveLabs or the shared store", async () => {
    for (const handler of Object.values(sessionRoutes)) {
      const response = await handler(post("http://127.0.0.1:3000/api/session/x", { origin: "http://127.0.0.1:3000" }));
      expect(response.status).toBe(404);
    }
    expect((await cronGET(new Request("http://127.0.0.1:3000/api/cron/cleanup", { headers: { authorization: "Bearer whatever-long-enough-secret" } }))).status).toBe(404);
    expect(getSessionDeps).not.toHaveBeenCalled();
  });
});

describe("hosted routes in hosted mode", () => {
  beforeEach(() => {
    vi.stubEnv("APP_MODE", "session");
    vi.stubEnv("APP_PASSWORD", "correct horse battery");
    vi.stubEnv("TWELVELABS_API_KEY", "tlk_test_key");
  });

  it("require the signed cookie even if the proxy were bypassed, and a same-site Origin", async () => {
    const url = "https://polbocus.vercel.app/api/session/x";
    const cookie = `${AUTH_COOKIE}=${await createSessionToken()}`;
    for (const handler of Object.values(sessionRoutes)) {
      expect((await handler(post(url, { origin: "https://polbocus.vercel.app" }))).status).toBe(401);
      expect((await handler(post(url, { origin: "https://polbocus.vercel.app", cookie: `${AUTH_COOKIE}=1.forged` }))).status).toBe(401);
      // Origin matching Host is not authentication, and a foreign Origin is refused outright.
      expect((await handler(post(url, { origin: "https://evil.example", cookie }))).status).toBe(403);
    }
    expect(getSessionDeps).not.toHaveBeenCalled();
    // A valid, same-origin request gets through to the session code.
    expect((await sessionRoutes.end(post(url, { origin: "https://polbocus.vercel.app", cookie }))).status).toBe(500);
    expect(getSessionDeps).toHaveBeenCalled();
  });

  it("hide the local library routes", async () => {
    expect((await videosGET(new Request("http://127.0.0.1:3000/api/videos", { headers: { host: "127.0.0.1:3000" } }))).status).toBe(404);
    expect(getDb).not.toHaveBeenCalled();
  });
});

describe("scheduled cleanup endpoint", () => {
  beforeEach(() => vi.stubEnv("APP_MODE", "session"));
  const cron = (authorization?: string) => new Request("https://polbocus.vercel.app/api/cron/cleanup", { headers: authorization ? { authorization } : {} });

  it("refuses without a configured secret, with a wrong one, or with a short one", async () => {
    expect((await cronGET(cron("Bearer "))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "short");
    expect((await cronGET(cron("Bearer short"))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "a-long-random-cron-secret-value");
    expect((await cronGET(cron())).status).toBe(401);
    expect((await cronGET(cron("Bearer a-long-random-cron-secret-valuX"))).status).toBe(401);
    expect((await cronGET(cron("a-long-random-cron-secret-value"))).status).toBe(401);
    expect(getSessionDeps).not.toHaveBeenCalled();
  });

  it("runs with the right secret", async () => {
    vi.stubEnv("CRON_SECRET", "a-long-random-cron-secret-value");
    const { memoryStore } = await import("@/lib/server/shared-store");
    const { fakeProvider } = await import("./fake-provider");
    const blob = { configured: () => true, list: vi.fn(async () => ({ blobs: [], hasMore: false })), remove: vi.fn() };
    getSessionDeps.mockImplementationOnce((() => ({ provider: fakeProvider(), blob, store: memoryStore() })) as never);
    const response = await cronGET(cron("Bearer a-long-random-cron-secret-value"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sessions: { checked: 0 }, sweep: { assets: { complete: true }, uploads: { complete: true } } });
  });
});

describe("local routes with a foreign Host", () => {
  beforeEach(() => {
    vi.stubEnv("APP_MODE", "");
    vi.stubEnv("VERCEL", "");
  });

  it("are refused before the database or provider is touched, with or without Origin", async () => {
    const foreign = "http://rebind.attacker.example:3000";
    expect((await videosGET(new Request(`${foreign}/api/videos`, { headers: { host: "rebind.attacker.example:3000" } }))).status).toBe(403);
    expect((await videosGET(new Request(`${foreign}/api/videos`, { headers: { host: "rebind.attacker.example:3000", origin: foreign } }))).status).toBe(403);
    expect((await setupGET(new Request(`${foreign}/api/setup`, { headers: { host: "rebind.attacker.example:3000" } }))).status).toBe(403);
    expect(getDb).not.toHaveBeenCalled();
    expect(getWorker).not.toHaveBeenCalled();
    expect(getProvider).not.toHaveBeenCalled();
  });
});
