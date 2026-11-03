// Single-owner sign-in for the hosted (session) mode. Uses Web Crypto only, so the
// same code runs in the proxy and in route handlers.

export const AUTH_COOKIE = "footage_auth";
export const SESSION_HOURS = 12;
export const MIN_PASSWORD_LENGTH = 12;
/** Longer inputs are rejected before hashing. */
export const MAX_PASSWORD_LENGTH = 256;
/**
 * Set after a successful sign-in. A browser that has signed in before gets its own attempt
 * budget, so someone hammering the login form cannot lock the owner out.
 */
export const DEVICE_COOKIE = "footage_device";
export const DEVICE_DAYS = 90;

const encoder = new TextEncoder();

/** Hosted mode: deployed on Vercel, or explicitly enabled for local testing. */
export function isSessionMode() {
  return Boolean(process.env.VERCEL) || process.env.APP_MODE === "session";
}

/** Env var names (never values) that still need to be set before sign-in works. */
export function missingAuthSettings(): string[] {
  const missing: string[] = [];
  const password = process.env.APP_PASSWORD ?? "";
  if (password.length < MIN_PASSWORD_LENGTH) missing.push(`APP_PASSWORD (at least ${MIN_PASSWORD_LENGTH} characters)`);
  if (!process.env.TWELVELABS_API_KEY?.trim()) missing.push("TWELVELABS_API_KEY");
  return missing;
}

function base64url(bytes: ArrayBuffer) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The signing key is derived from the password and the API key, so changing either
 * signs everyone out; no extra secret has to be configured.
 */
async function signingKey(password: string, apiKey: string, purpose = "footage-session") {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`${purpose}\u0000${password}\u0000${apiKey}`));
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function sign(payload: string, password: string, apiKey: string, purpose?: string) {
  const key = await signingKey(password, apiKey, purpose);
  return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function createSessionToken(now = Date.now(), env = process.env) {
  const expires = now + SESSION_HOURS * 3600_000;
  return `${expires}.${await sign(String(expires), env.APP_PASSWORD ?? "", env.TWELVELABS_API_KEY ?? "")}`;
}

export async function verifySessionToken(token: string | undefined, now = Date.now(), env = process.env) {
  if (!token || (env.APP_PASSWORD ?? "").length < MIN_PASSWORD_LENGTH) return false;
  const [expires, signature] = token.split(".");
  if (!/^\d{13}$/.test(expires ?? "") || !signature || Number(expires) < now) return false;
  const expected = await sign(expires, env.APP_PASSWORD ?? "", env.TWELVELABS_API_KEY ?? "");
  return constantTimeEqual(encoder.encode(expected), encoder.encode(signature));
}

/** `<device id>.<expires>.<signature>`; the ID only keys this browser's attempt budget. */
export async function createDeviceToken(now = Date.now(), env = process.env) {
  const payload = `${crypto.randomUUID().replace(/-/g, "")}.${now + DEVICE_DAYS * 86_400_000}`;
  return `${payload}.${await sign(payload, env.APP_PASSWORD ?? "", env.TWELVELABS_API_KEY ?? "", "footage-device")}`;
}

/** The device ID from a valid, unexpired device token, or null. */
export async function verifyDeviceToken(token: string | undefined, now = Date.now(), env = process.env) {
  if (!token || token.length > 200 || (env.APP_PASSWORD ?? "").length < MIN_PASSWORD_LENGTH) return null;
  const [id, expires, signature] = token.split(".");
  if (!/^[0-9a-f]{32}$/.test(id ?? "") || !/^\d{13}$/.test(expires ?? "") || !signature || Number(expires) < now) return null;
  const expected = await sign(`${id}.${expires}`, env.APP_PASSWORD ?? "", env.TWELVELABS_API_KEY ?? "", "footage-device");
  return constantTimeEqual(encoder.encode(expected), encoder.encode(signature)) ? id : null;
}

export function readCookie(request: Request, name: string) {
  return request.headers.get("cookie")?.split(/;\s*/).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

export async function passwordMatches(candidate: string, env = process.env) {
  const configured = env.APP_PASSWORD ?? "";
  if (configured.length < MIN_PASSWORD_LENGTH || candidate.length > MAX_PASSWORD_LENGTH) return false;
  // Compare digests so the comparison time does not depend on the password length.
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(candidate)), crypto.subtle.digest("SHA-256", encoder.encode(configured))]);
  return constantTimeEqual(new Uint8Array(a), new Uint8Array(b));
}

/** Rejects state-changing requests from other sites (the session cookie is SameSite=Lax as well). */
export function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}
