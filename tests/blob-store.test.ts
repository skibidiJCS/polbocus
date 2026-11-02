import { afterEach, describe, expect, it, vi } from "vitest";
import { blobUploadMethod } from "@/lib/server/blob-store";

afterEach(() => vi.unstubAllEnvs());

describe("blobUploadMethod", () => {
  it("uses presigned uploads for stores connected with Vercel's default OIDC auth", () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("BLOB_STORE_ID", "store_abc");
    vi.stubEnv("BLOB_WEBHOOK_PUBLIC_KEY", "key");
    expect(blobUploadMethod()).toBe("presigned");
  });
  it("falls back to client tokens when only a read-write token exists", () => {
    vi.stubEnv("BLOB_STORE_ID", "");
    vi.stubEnv("BLOB_WEBHOOK_PUBLIC_KEY", "");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test");
    expect(blobUploadMethod()).toBe("client-token");
  });
  it("reports nothing connected", () => {
    vi.stubEnv("BLOB_STORE_ID", "");
    vi.stubEnv("BLOB_WEBHOOK_PUBLIC_KEY", "");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    expect(blobUploadMethod()).toBeNull();
  });
});
