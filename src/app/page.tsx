import { HostedNotice } from "@/components/workspace/hosted-notice";
import { SessionWorkspace } from "@/components/workspace/session-workspace";
import { Workspace } from "@/components/workspace/workspace";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isSessionMode } from "@/lib/auth";
import { isLocalHost } from "@/lib/hosts";
import { blobUploadMethod } from "@/lib/server/blob-store";
import { getServerConfig } from "@/lib/server/config";
import { getDb } from "@/lib/server/db";
import { getWorker } from "@/lib/server/runtime";
import { listVideoSummaries } from "@/lib/server/videos-repo";
import type { VideoSummary } from "@/types/video";

export const dynamic = "force-dynamic";

export default async function Home() {
  // Hosted: one-time sessions behind sign-in (the proxy has already checked the cookie).
  if (isSessionMode()) {
    const uploadMethod = blobUploadMethod();
    const missing = [
      !process.env.TWELVELABS_API_KEY?.trim() && "TWELVELABS_API_KEY",
      !uploadMethod && "A private Vercel Blob store connected to this project. In Vercel: Storage → Create → Blob → choose Private → connect it to this project with Production ticked, then redeploy. If it’s already connected, redeploy — the deployment you’re viewing was built before the connection.",
    ].filter(Boolean) as string[];
    if (missing.length) return <HostedNotice reason="setup" missing={missing} />;
    return <SessionWorkspace presignedUploads={uploadMethod === "presigned"} />;
  }
  // The proxy already refuses other hosts; checked again before reading the library.
  if (!isLocalHost((await headers()).get("host"))) notFound();
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
