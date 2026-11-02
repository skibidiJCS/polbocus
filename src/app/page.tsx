import { HostedNotice } from "@/components/workspace/hosted-notice";
import { SessionWorkspace } from "@/components/workspace/session-workspace";
import { Workspace } from "@/components/workspace/workspace";
import { isSessionMode } from "@/lib/auth";
import { getServerConfig } from "@/lib/server/config";
import { getDb } from "@/lib/server/db";
import { getWorker } from "@/lib/server/runtime";
import { listVideoSummaries } from "@/lib/server/videos-repo";
import type { VideoSummary } from "@/types/video";

export const dynamic = "force-dynamic";

export default function Home() {
  // Hosted: one-time sessions behind sign-in (the proxy has already checked the cookie).
  if (isSessionMode()) {
    // Browser uploads need the store's read-write token (an OIDC connection alone can't issue upload tokens).
    const blobHint = process.env.BLOB_STORE_ID
      ? "Your Blob store is connected, but this deployment can’t see its read-write token. Open the Blob store in Vercel, copy the BLOB_READ_WRITE_TOKEN value, add it under Settings → Environment Variables (tick Production), then redeploy."
      : "No Blob store is connected to this project yet. In Vercel: Storage → Create → Blob → choose Private → connect it to this project with Production ticked, then redeploy. (If you already did, the deployment you’re viewing was built before it was connected — redeploy.)";
    const missing = [
      !process.env.TWELVELABS_API_KEY?.trim() && "TWELVELABS_API_KEY",
      !process.env.BLOB_READ_WRITE_TOKEN && blobHint,
    ].filter(Boolean) as string[];
    if (missing.length) return <HostedNotice reason="setup" missing={missing} />;
    return <SessionWorkspace />;
  }
  const config = getServerConfig();
  let videos: VideoSummary[];
  try {
    getWorker();
    videos = listVideoSummaries(getDb());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return <HostedNotice reason="storage" detail={code ? `${code} while opening ${config.dataDir}` : undefined} />;
  }
  return <Workspace apiKeyConfigured={Boolean(config.apiKey)} maxUploadBytes={config.maxUploadBytes} initialVideos={videos} />;
}
