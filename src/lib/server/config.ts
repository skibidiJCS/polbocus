import "server-only";
import path from "node:path";

/** TwelveLabs v1.3 limits verified against docs.twelvelabs.io (Marengo 3.0, direct and multipart uploads). */
export const PROVIDER_LIMITS = {
  // Marengo 3.0: "File size: ≤ 4 GB". Decimal bytes keep us under the limit either way it is read.
  maxUploadBytes: 4_000_000_000,
  // Direct uploads (POST /assets) accept local video files up to 200 MB; larger files use multipart uploads.
  directUploadMaxBytes: 200_000_000,
  minDurationSeconds: 4,
  maxDurationSeconds: 4 * 60 * 60,
} as const;

export function getServerConfig() {
  const dataDir = path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env.DATA_DIR || "./data");
  const publicDir = path.resolve(process.cwd(), "public");
  const relative = path.relative(publicDir, dataDir);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("DATA_DIR must be outside public/.");
  }
  const configuredMax = Number(process.env.MAX_UPLOAD_MB);
  const maxUploadBytes = Number.isFinite(configuredMax) && configuredMax > 0
    ? Math.min(Math.floor(configuredMax * 1_000_000), PROVIDER_LIMITS.maxUploadBytes)
    : PROVIDER_LIMITS.maxUploadBytes;
  return {
    apiKey: process.env.TWELVELABS_API_KEY?.trim() || null,
    indexId: process.env.TWELVELABS_INDEX_ID?.trim() || null,
    dataDir,
    videosDir: path.join(dataDir, "videos"),
    tmpDir: path.join(dataDir, "tmp"),
    maxUploadBytes,
  };
}
