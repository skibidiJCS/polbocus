import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_COOKIE, createSessionToken } from "@/lib/auth";
import { proxy } from "@/proxy";

beforeEach(() => {
  vi.stubEnv("APP_MODE", "session");
  vi.stubEnv("APP_PASSWORD", "correct horse battery");
  vi.stubEnv("TWELVELABS_API_KEY", "tlk_test_key");
});
afterEach(() => vi.unstubAllEnvs());

const request = (path: string, cookie?: string) => new NextRequest(`https://polbocus.vercel.app${path}`, { headers: cookie ? { cookie: `${AUTH_COOKIE}=${cookie}` } : {} });

describe("proxy (hosted sign-in gate)", () => {
  it("redirects pages and rejects API calls without a session", async () => {
    const page = await proxy(request("/"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("https://polbocus.vercel.app/login");
    const api = await proxy(request("/api/session/search"));
    expect(api.status).toBe(401);
  });

  it("lets the login page through, and everything through with a valid cookie", async () => {
    expect((await proxy(request("/login"))).headers.get("x-middleware-next")).toBe("1");
    const token = await createSessionToken();
    expect((await proxy(request("/api/session/search", token))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(request("/", "123.forged"))).status).toBe(307);
  });

  it("does nothing in local mode", async () => {
    vi.stubEnv("APP_MODE", "");
    vi.stubEnv("VERCEL", "");
    expect((await proxy(request("/api/videos"))).headers.get("x-middleware-next")).toBe("1");
  });
});
