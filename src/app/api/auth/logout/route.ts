import { cookies } from "next/headers";
import { logout } from "@/domain/identity";
import { SESSION_COOKIE, route } from "@/server/http";

export const POST = route(
  "auth.logout",
  async ({ ctx }) => {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (token) logout(ctx, token);
    store.delete(SESSION_COOKIE);
    return { ok: true };
  },
  { auth: false },
);
