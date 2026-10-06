import { z } from "zod";
import { createBox } from "@/domain/inventory-mutations";
import { actionId, id, route } from "@/server/http";

const Body = z.object({ actionId, label: z.string(), roomId: id.nullish() });

export const POST = route<{ moveId: string }>("box.create", async ({ json, ctx, actor, params }) => {
  const body = await json(Body);
  return createBox(ctx, actor, body.actionId, {
    moveId: params.moveId,
    label: body.label,
    roomId: body.roomId,
  });
});
