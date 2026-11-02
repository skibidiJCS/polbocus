// Starts the indexing worker when the server boots so pending jobs resume
// after a restart without waiting for a browser request.
export async function register() {
  // Serverless hosts (Vercel) have a read-only disk; the page explains instead of crashing.
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.VERCEL) return;
  const { getWorker } = await import("@/lib/server/runtime");
  try {
    getWorker();
  } catch (error) {
    // Most likely an unwritable DATA_DIR; the page shows the details.
    console.error("Indexing worker did not start:", error instanceof Error ? error.message : "unknown error");
  }
}
