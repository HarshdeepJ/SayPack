import { cookies } from "next/headers";
import { z } from "zod";
import { login } from "@/domain/identity";
import { SESSION_COOKIE, readJson, route } from "@/server/http";

const Body = z.object({ email: z.string().max(254), password: z.string().max(1024) });

export const POST = route(
  "auth.login",
  async ({ request, ctx }) => {
    const body = await readJson(request, Body);
    const session = await login(ctx, body.email, body.password);
    (await cookies()).set(SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: process.env.SAYPACK_INSECURE_COOKIES !== "1",
      sameSite: "lax",
      path: "/",
      expires: new Date(session.expiresAt),
    });
    return { ok: true };
  },
  { auth: false },
);
