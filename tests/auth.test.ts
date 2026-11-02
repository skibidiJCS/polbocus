import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, isSameOrigin, missingAuthSettings, passwordMatches, SESSION_HOURS, verifySessionToken } from "@/lib/auth";

const env = { APP_PASSWORD: "correct horse battery", TWELVELABS_API_KEY: "tlk_test_key" } as unknown as NodeJS.ProcessEnv;

describe("session tokens", () => {
  it("accepts a fresh token and rejects expired, tampered, or re-keyed ones", async () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    const token = await createSessionToken(now, env);
    expect(await verifySessionToken(token, now + 1000, env)).toBe(true);
    expect(await verifySessionToken(token, now + SESSION_HOURS * 3600_000 + 1, env)).toBe(false);
    const [expires, sig] = token.split(".");
    expect(await verifySessionToken(`${Number(expires) + 999_999}.${sig}`, now, env)).toBe(false);
    expect(await verifySessionToken(`${expires}.${sig.slice(0, -2)}xx`, now, env)).toBe(false);
    // Changing the password signs everyone out.
    expect(await verifySessionToken(token, now, { ...env, APP_PASSWORD: "a different password" })).toBe(false);
    expect(await verifySessionToken(undefined, now, env)).toBe(false);
    expect(await verifySessionToken("garbage", now, env)).toBe(false);
  });

  it("refuses to work with a short or missing password", async () => {
    const weak = { ...env, APP_PASSWORD: "short" };
    expect(await verifySessionToken(await createSessionToken(Date.now(), weak), Date.now(), weak)).toBe(false);
    expect(await passwordMatches("short", weak)).toBe(false);
  });

  it("checks the password exactly", async () => {
    expect(await passwordMatches("correct horse battery", env)).toBe(true);
    expect(await passwordMatches("correct horse batter", env)).toBe(false);
    expect(await passwordMatches("", env)).toBe(false);
  });
});

describe("setup and origin checks", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("lists missing settings by name only", () => {
    vi.stubEnv("APP_PASSWORD", "tiny");
    vi.stubEnv("TWELVELABS_API_KEY", "");
    const missing = missingAuthSettings();
    expect(missing.join(" ")).toMatch(/APP_PASSWORD/);
    expect(missing).toContain("TWELVELABS_API_KEY");
    expect(missing.join(" ")).not.toContain("tiny");
  });

  it("rejects cross-site requests", () => {
    const req = (origin?: string) => new Request("https://polbocus.vercel.app/api/session/end", { method: "POST", headers: { host: "polbocus.vercel.app", ...(origin ? { origin } : {}) } });
    expect(isSameOrigin(req("https://polbocus.vercel.app"))).toBe(true);
    expect(isSameOrigin(req())).toBe(true);
    expect(isSameOrigin(req("https://evil.example"))).toBe(false);
  });
});
