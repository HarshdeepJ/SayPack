import { z } from "zod";
import { markPacked } from "@/domain/evidence";
import { actionId, revision, route } from "@/server/http";

const Body = z.object({ actionId, expectedRevision: revision });

export const POST = route<{ itemId: string }>("item.mark_packed", async ({ json, ctx, actor, params }) => {
  const body = await json(Body);
  return markPacked(ctx, actor, body.actionId, { itemId: params.itemId, expectedRevision: body.expectedRevision });
});
