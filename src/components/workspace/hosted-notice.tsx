import { Logo } from "./logo";

/** Shown instead of crashing when the app is missing something it needs. */
export function HostedNotice({ reason, detail, missing = [] }: { reason: "setup" | "storage"; detail?: string; missing?: string[] }) {
  return (
    <main className="notice-page">
      <Logo />
      {reason === "setup" ? (
        <>
          <h1>Almost there.</h1>
          <p>You’re signed in. Before videos can be uploaded, this deployment needs:</p>
          <ul className="notice-list">{missing.map((item) => <li key={item}>{item}</li>)}</ul>
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
