/** Shown instead of crashing when the app runs somewhere it cannot work. */
export function HostedNotice({ reason, detail }: { reason: "hosted" | "storage"; detail?: string }) {
  return (
    <main className="notice-page">
      <p className="wordmark">footage</p>
      {reason === "hosted" ? (
        <>
          <h1>This app runs on your own computer.</h1>
          <p>
            Footage keeps your videos and its database on local disk, indexes them with a background process,
            and has no sign-in. A serverless host like Vercel has none of the first two, and without the third
            anyone with the link could use your TwelveLabs key.
          </p>
          <p>Run it locally instead:</p>
          <pre>npm install{"\n"}npm run db:init{"\n"}npm run dev</pre>
          <p className="notice-foot">then open http://127.0.0.1:3000</p>
        </>
      ) : (
        <>
          <h1>The data folder can’t be opened.</h1>
          <p>Footage needs a writable folder for videos and its database. Check that <code>DATA_DIR</code> in <code>.env.local</code> points to a folder you can write to, then restart the server.</p>
          {detail && <p className="notice-foot">{detail}</p>}
        </>
      )}
    </main>
  );
}
