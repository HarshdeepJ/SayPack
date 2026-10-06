import { z } from "zod";
import { createRoom } from "@/domain/inventory-mutations";
import { actionId, route } from "@/server/http";

const Body = z.object({ actionId, name: z.string() });

export const POST = route<{ moveId: string }>("room.create", async ({ json, ctx, actor, params }) => {
  const body = await json(Body);
  return createRoom(ctx, actor, body.actionId, { moveId: params.moveId, name: body.name });
});
