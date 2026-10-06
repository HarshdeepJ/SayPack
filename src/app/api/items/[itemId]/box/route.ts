import { z } from "zod";
import { assignItemToBox } from "@/domain/inventory-mutations";
import { actionId, id, readJson, revision, route } from "@/server/http";

const Body = z.object({ actionId, expectedRevision: revision, boxId: id.nullable() });

export const POST = route<{ itemId: string }>("item.assign_box", async ({ request, ctx, actor, params }) => {
  const body = await readJson(request, Body);
  return assignItemToBox(ctx, actor, body.actionId, {
    itemId: params.itemId,
    expectedRevision: body.expectedRevision,
    boxId: body.boxId,
  });
});
