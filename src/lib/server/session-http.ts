import "server-only";
import { isSameOrigin } from "@/lib/auth";
import { errorResponse } from "./http";

export { errorResponse };

/** JSON body from fetch() or navigator.sendBeacon() (which sends text/plain). */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text().catch(() => "");
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function rejectCrossOrigin(request: Request): Response | null {
  return isSameOrigin(request) ? null : Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
}
