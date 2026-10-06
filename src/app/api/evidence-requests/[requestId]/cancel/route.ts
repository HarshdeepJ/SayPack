import { z } from "zod";
import { cancelEvidenceRequest } from "@/domain/incidents";
import { actionId, revision, route } from "@/server/http";

const Body = z.object({ actionId, expectedRevision: revision });

export const POST = route<{ requestId: string }>("evidence.cancel", async ({ json, ctx, actor, params }) => {
  const body = await json(Body);
  return cancelEvidenceRequest(ctx, actor, body.actionId, {
    requestId: params.requestId,
    expectedRevision: body.expectedRevision,
  });
});
