import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_COOKIE, createSessionToken } from "@/lib/auth";
import { proxy } from "@/proxy";

const passes = (response: Response) => response.headers.get("x-middleware-next") === "1";

describe("proxy in hosted mode (sign-in gate)", () => {
  beforeEach(() => {
    vi.stubEnv("APP_MODE", "session");
    vi.stubEnv("APP_PASSWORD", "correct horse battery");
    vi.stubEnv("TWELVELABS_API_KEY", "tlk_test_key");
  });
  afterEach(() => vi.unstubAllEnvs());

  const request = (path: string, cookie?: string, headers: Record<string, string> = {}) =>
    new NextRequest(`https://polbocus.vercel.app${path}`, { headers: { ...(cookie ? { cookie: `${AUTH_COOKIE}=${cookie}` } : {}), ...headers } });

  it("redirects pages and rejects API calls without a session", async () => {
    const page = await proxy(request("/"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("https://polbocus.vercel.app/login");
    expect((await proxy(request("/api/session/search"))).status).toBe(401);
    expect((await proxy(request("/?_rsc=abc", undefined, { rsc: "1" }))).status).toBe(307);
  });

  it("lets the login page through, and everything through with a valid cookie", async () => {
    expect(passes(await proxy(request("/login")))).toBe(true);
    const token = await createSessionToken();
    expect(passes(await proxy(request("/api/session/search", token)))).toBe(true);
    expect((await proxy(request("/", "123.forged"))).status).toBe(307);
  });

  it("hides local-library routes, even with a valid cookie", async () => {
    const token = await createSessionToken();
    for (const path of ["/api/videos", "/api/videos/abc/media", "/api/search", "/api/setup"]) {
      expect((await proxy(request(path, token))).status).toBe(404);
    }
  });

  it("leaves the cron endpoint to its own secret check", async () => {
    expect(passes(await proxy(request("/api/cron/cleanup")))).toBe(true);
    expect((await proxy(request("/api/cron/other"))).status).toBe(401);
  });
});

describe("proxy in local mode (hostname boundary)", () => {
  beforeEach(() => {
    vi.stubEnv("APP_MODE", "");
    vi.stubEnv("VERCEL", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  // Browsers always send Host; NextRequest does not derive it from the URL.
  const request = (url: string, headers: Record<string, string> = {}) => new NextRequest(url, { headers: { host: new URL(url).host, ...headers } });

  it("rejects a foreign Host on the root page and on RSC requests", async () => {
    expect((await proxy(request("http://rebind.attacker.example:3000/"))).status).toBe(403);
    expect((await proxy(request("http://rebind.attacker.example:3000/?_rsc=1x2y", { rsc: "1", "next-router-state-tree": "%5B%5D" }))).status).toBe(403);
    expect((await proxy(request("http://rebind.attacker.example:3000/api/videos"))).status).toBe(403);
  });

  it("rejects a foreign Host even when Origin matches it, or when Origin is missing", async () => {
    const foreign = "http://rebind.attacker.example:3000";
    expect((await proxy(request(`${foreign}/api/videos`, { origin: foreign }))).status).toBe(403);
    expect((await proxy(request(`${foreign}/`))).status).toBe(403);
    // The Host header is what counts, whatever the URL says; a missing one is refused too.
    expect((await proxy(request("http://127.0.0.1:3000/", { host: "rebind.attacker.example:3000" }))).status).toBe(403);
    expect((await proxy(new NextRequest("http://127.0.0.1:3000/"))).status).toBe(403);
  });

  it("serves localhost names, and hides hosted-only routes", async () => {
    for (const host of ["127.0.0.1:3000", "localhost:3000", "[::1]:3000"]) {
      expect(passes(await proxy(request(`http://${host}/`)))).toBe(true);
    }
    for (const path of ["/api/session/start", "/api/session/end", "/api/auth/login", "/api/cron/cleanup"]) {
      expect((await proxy(request(`http://127.0.0.1:3000${path}`))).status).toBe(404);
    }
  });
});
