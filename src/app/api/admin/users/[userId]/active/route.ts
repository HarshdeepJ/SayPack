import { z } from "zod";
import { setUserActive } from "@/domain/identity";
import { actionId, route } from "@/server/http";

const Body = z.object({ actionId, active: z.boolean() });

export const POST = route<{ userId: string }>("user.set_active", async ({ json, ctx, actor, params }) => {
  const body = await json(Body);
  return setUserActive(ctx, actor, body.actionId, { userId: params.userId, active: body.active });
});
