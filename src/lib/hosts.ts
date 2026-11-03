// Host checks shared by the proxy (edge-safe, no Node APIs) and route handlers.

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function hostnameOf(hostHeader: string | null | undefined) {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Local library mode only answers requests addressed to this machine by name. A page on
 * another site that rebinds its own hostname to 127.0.0.1 still sends its hostname in Host,
 * so it is refused before any private data is read. Origin is not involved: a matching
 * foreign Origin and Host, or no Origin at all, gets the same answer.
 */
export function isLocalHost(hostHeader: string | null | undefined) {
  const hostname = hostnameOf(hostHeader);
  return hostname !== null && LOCAL_HOSTNAMES.has(hostname);
}

/** Routes that only exist in one mode; the other mode answers 404 before touching anything. */
export const HOSTED_ONLY_PREFIXES = ["/api/session/", "/api/auth/", "/api/cron/"];
export const LOCAL_ONLY_PREFIXES = ["/api/videos", "/api/search", "/api/setup"];

export function matchesPrefix(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix.replace(/\/$/, "") || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
}
