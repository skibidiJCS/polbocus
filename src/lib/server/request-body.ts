import "server-only";

export class BodyTooLargeError extends Error {}

/**
 * Reads a request body as text, refusing more than `maxBytes` without buffering the rest.
 * Checks Content-Length first, then counts bytes as they stream in (it can be absent or wrong).
 */
export async function readLimitedText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new BodyTooLargeError();
      chunks.push(value);
    }
  } finally {
    if (total > maxBytes) reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** A JSON object from at most `maxBytes`; anything else becomes {}. Throws BodyTooLargeError. */
export async function readLimitedJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const text = await readLimitedText(request, maxBytes);
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
