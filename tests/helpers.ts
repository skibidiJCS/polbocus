import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/server/db";
import type { Db } from "@/lib/server/db";

export function tempDir(prefix = "footage-test-") {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function tempDb(dir: string): Db {
  return openDb(path.join(dir, "test.sqlite"));
}

/** Minimal valid-looking MP4 header ("ftyp" box, isom brand) followed by filler. */
export function fakeMp4(size = 4096, fill = 0x41) {
  const bytes = Buffer.alloc(size, fill);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftypisom", 4, "latin1");
  return bytes;
}

export function streamOf(...chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  });
}

export function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
}
