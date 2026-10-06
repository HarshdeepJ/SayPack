import { z } from "zod";
import { sealBox } from "@/domain/inventory-mutations";
import { actionId, revision, route } from "@/server/http";

const Body = z.object({ actionId, expectedRevision: revision });

export const POST = route<{ boxId: string }>("box.seal", async ({ json, ctx, actor, params }) => {
  const body = await json(Body);
  return sealBox(ctx, actor, body.actionId, { boxId: params.boxId, expectedRevision: body.expectedRevision });
});
