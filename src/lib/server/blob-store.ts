import "server-only";
import { del, get, head, issueSignedToken, list, presignUrl } from "@vercel/blob";

/** The parts of a private Vercel Blob store the session flow needs (swappable in tests). */
export interface BlobStore {
  configured(): boolean;
  head(pathname: string): Promise<{ size: number; contentType: string } | null>;
  /** First bytes of the file, for checking its signature. */
  readStart(pathname: string, bytes: number): Promise<Uint8Array>;
  /** A GET URL that works without credentials until `validUntil` (ms since epoch). */
  presignGet(pathname: string, validUntil: number): Promise<string>;
  remove(pathnames: string[]): Promise<void>;
  list(prefix: string): Promise<{ pathname: string; uploadedAt: Date }[]>;
}

/**
 * How the browser uploads: Vercel connects stores with OIDC by default (BLOB_STORE_ID +
 * BLOB_WEBHOOK_PUBLIC_KEY, no read-write token), which needs presigned uploads.
 */
export function blobUploadMethod(): "presigned" | "client-token" | null {
  if (process.env.BLOB_STORE_ID && process.env.BLOB_WEBHOOK_PUBLIC_KEY) return "presigned";
  if (process.env.BLOB_READ_WRITE_TOKEN) return "client-token";
  return null;
}

export function vercelBlobStore(): BlobStore {
  return {
    configured: () => blobUploadMethod() !== null,

    async head(pathname) {
      try {
        const info = await head(pathname);
        return { size: info.size, contentType: info.contentType };
      } catch (error) {
        if (error instanceof Error && error.name === "BlobNotFoundError") return null;
        throw error;
      }
    },

    async readStart(pathname, bytes) {
      const result = await get(pathname, { access: "private", headers: { Range: `bytes=0-${bytes - 1}` } });
      if (!result?.stream) return new Uint8Array();
      const reader = result.stream.getReader();
      const out = new Uint8Array(bytes);
      let filled = 0;
      try {
        while (filled < bytes) {
          const { done, value } = await reader.read();
          if (done) break;
          const take = Math.min(bytes - filled, value.byteLength);
          out.set(value.subarray(0, take), filled);
          filled += take;
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      return out.subarray(0, filled);
    },

    async presignGet(pathname, validUntil) {
      const token = await issueSignedToken({ pathname, operations: ["get"], validUntil });
      const { presignedUrl } = await presignUrl(token, { operation: "get", pathname, access: "private", validUntil });
      return presignedUrl;
    },

    async remove(pathnames) {
      if (pathnames.length) await del(pathnames);
    },

    async list(prefix) {
      const result = await list({ prefix, limit: 1000 });
      return result.blobs.map((blob) => ({ pathname: blob.pathname, uploadedAt: new Date(blob.uploadedAt) }));
    },
  };
}
