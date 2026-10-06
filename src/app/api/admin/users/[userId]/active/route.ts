import { z } from "zod";
import { setUserActive } from "@/domain/identity";
import { actionId, readJson, route } from "@/server/http";

const Body = z.object({ actionId, active: z.boolean() });

export const POST = route<{ userId: string }>("user.set_active", async ({ request, ctx, actor, params }) => {
  const body = await readJson(request, Body);
  return setUserActive(ctx, actor, body.actionId, { userId: params.userId, active: body.active });
});
