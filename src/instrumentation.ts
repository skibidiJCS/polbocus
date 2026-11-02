// Starts the indexing worker when the server boots so pending jobs resume
// after a restart without waiting for a browser request.
export async function register() {
  // Hosted (session) mode keeps nothing on disk and needs no worker.
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.VERCEL || process.env.APP_MODE === "session") return;
  const { getWorker } = await import("@/lib/server/runtime");
  try {
    getWorker();
  } catch (error) {
    // Most likely an unwritable DATA_DIR; the page shows the details.
    console.error("Indexing worker did not start:", error instanceof Error ? error.message : "unknown error");
  }
}
