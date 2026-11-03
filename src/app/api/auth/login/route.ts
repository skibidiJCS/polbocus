import { createLoginHandler } from "@/lib/server/login-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createLoginHandler();
