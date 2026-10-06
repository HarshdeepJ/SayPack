import { z } from "zod";
import { reopenBox } from "@/domain/inventory-mutations";
import { actionId, readJson, revision, route } from "@/server/http";

const Body = z.object({ actionId, expectedRevision: revision });

export const POST = route<{ boxId: string }>("box.reopen", async ({ request, ctx, actor, params }) => {
  const body = await readJson(request, Body);
  return reopenBox(ctx, actor, body.actionId, { boxId: params.boxId, expectedRevision: body.expectedRevision });
});
