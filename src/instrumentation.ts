// Starts the indexing worker when the server boots so pending jobs resume
// after a restart without waiting for a browser request.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getWorker } = await import("@/lib/server/runtime");
    getWorker();
  }
}
