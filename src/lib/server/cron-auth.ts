import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_CRON_SECRET_LENGTH = 16;

/**
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Without a configured secret of
 * reasonable length the endpoint refuses everything, so cleanup is never publicly callable.
 */
export function isAuthorizedCron(request: Request, secret = process.env.CRON_SECRET ?? "") {
  if (secret.length < MIN_CRON_SECRET_LENGTH) return false;
  const header = request.headers.get("authorization") ?? "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
