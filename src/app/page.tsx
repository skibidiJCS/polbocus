import { HostedNotice } from "@/components/workspace/hosted-notice";
import { Workspace } from "@/components/workspace/workspace";
import { getServerConfig } from "@/lib/server/config";
import { getDb } from "@/lib/server/db";
import { getWorker } from "@/lib/server/runtime";
import { listVideoSummaries } from "@/lib/server/videos-repo";
import type { VideoSummary } from "@/types/video";

export const dynamic = "force-dynamic";

export default function Home() {
  // Serverless hosts have no persistent disk or long-running process, and the app has no login.
  if (process.env.VERCEL) return <HostedNotice reason="hosted" />;
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
