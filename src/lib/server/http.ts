import "server-only";
import { ProviderError, ProviderNotConfiguredError } from "./video-provider";
import { ServiceError, UploadError } from "./errors";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostname(hostHeader: string | null) {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Single-user localhost prototype: refuse requests addressed to non-local hosts
 * (DNS rebinding) and state-changing requests from other origins (cross-site
 * requests could otherwise trigger uploads, deletions, or billable searches).
 */
export function rejectNonLocal(request: Request): Response | null {
  const host = hostname(request.headers.get("host"));
  if (!host || !LOCAL_HOSTS.has(host)) {
    return Response.json({ error: "This prototype only accepts requests to localhost." }, { status: 403 });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("origin");
    if (origin) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        // Treated as foreign below.
      }
      if (originHost !== request.headers.get("host")) {
        return Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
      }
    }
  }
  return null;
}

export const noStore = { "Cache-Control": "no-store" };

export function errorResponse(error: unknown): Response {
  if (error instanceof ServiceError || error instanceof UploadError) {
    const headers: Record<string, string> = { ...noStore };
    if (error instanceof ServiceError && error.retryAfterSeconds !== undefined) headers["Retry-After"] = String(error.retryAfterSeconds);
    return Response.json({ error: error.message }, { status: error.status, headers });
  }
  if (error instanceof ProviderNotConfiguredError) {
    return Response.json({ error: error.message }, { status: 503, headers: noStore });
  }
  if (error instanceof ProviderError) {
    if (error.status === 429) {
      const wait = error.retryAfterSeconds;
      return Response.json(
        { error: `TwelveLabs rate limit reached.${wait !== undefined ? ` Try again in about ${wait} seconds.` : " Try again shortly."}`, retryAfterSeconds: wait ?? null },
        { status: 429, headers: { ...noStore, ...(wait !== undefined ? { "Retry-After": String(wait) } : {}) } },
      );
    }
    if (error.status === 401 || error.status === 403) {
      return Response.json({ error: "TwelveLabs rejected the API key. Check TWELVELABS_API_KEY in .env.local and restart the server." }, { status: 502, headers: noStore });
    }
    return Response.json({ error: error.message, temporary: error.retryable }, { status: error.retryable ? 503 : 502, headers: noStore });
  }
  console.error("Unexpected server error:", error instanceof Error ? error.message : "unknown");
  return Response.json({ error: "Unexpected server error." }, { status: 500, headers: noStore });
}
