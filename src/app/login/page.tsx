import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/workspace/login-form";
import { AUTH_COOKIE, isSessionMode, missingAuthSettings, verifySessionToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!isSessionMode()) redirect("/");
  if (await verifySessionToken((await cookies()).get(AUTH_COOKIE)?.value)) redirect("/");
  const missing = missingAuthSettings();
  return (
    <main className="login">
      <p className="wordmark">footage</p>
      <h1>Sign in</h1>
      <p className="lede">This site is private. Enter your password to continue.</p>
      {missing.length ? (
        <div className="login-setup">
          <p>Sign-in isn’t set up yet. In Vercel, open this project’s <strong>Settings → Environment Variables</strong>, add the following, then redeploy:</p>
          <ul>{missing.map((name) => <li key={name}><code>{name}</code></li>)}</ul>
        </div>
      ) : (
        <LoginForm />
      )}
    </main>
  );
}
