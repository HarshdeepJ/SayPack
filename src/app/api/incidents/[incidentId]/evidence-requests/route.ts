import { z } from "zod";
import { requestEvidence } from "@/domain/incidents";
import { actionId, route } from "@/server/http";

const Body = z.object({ actionId, requestText: z.string() });

export const POST = route<{ incidentId: string }>("evidence.request", async ({ json, ctx, actor, params }) => {
  const body = await json(Body);
  return requestEvidence(ctx, actor, body.actionId, {
    incidentId: params.incidentId,
    requestText: body.requestText,
  });
});
