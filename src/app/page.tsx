import { Workspace } from "@/components/workspace/workspace";
import { getServerConfig } from "@/lib/server/config";
import { getDb } from "@/lib/server/db";
import { getWorker } from "@/lib/server/runtime";
import { listVideoSummaries } from "@/lib/server/videos-repo";
export const dynamic = "force-dynamic";
export default function Home() {
  const config = getServerConfig();
  getWorker();
  return <Workspace apiKeyConfigured={Boolean(config.apiKey)} maxUploadBytes={config.maxUploadBytes} initialVideos={listVideoSummaries(getDb())} />;
}
