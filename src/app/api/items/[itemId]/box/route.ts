import { z } from "zod";
import { assignItemToBox } from "@/domain/inventory-mutations";
import { actionId, id, revision, route } from "@/server/http";

const Body = z.object({ actionId, expectedRevision: revision, boxId: id.nullable() });

export const POST = route<{ itemId: string }>("item.assign_box", async ({ json, ctx, actor, params }) => {
  const body = await json(Body);
  return assignItemToBox(ctx, actor, body.actionId, {
    itemId: params.itemId,
    expectedRevision: body.expectedRevision,
    boxId: body.boxId,
  });
});
