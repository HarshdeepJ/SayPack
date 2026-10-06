import { z } from "zod";
import { recordRepack } from "@/domain/incidents";
import { actionId, revision, route } from "@/server/http";

const Body = z.object({ actionId, expectedRevision: revision });

export const POST = route<{ incidentId: string }>("incident.record_repack", async ({ json, ctx, actor, params }) => {
  const body = await json(Body);
  return recordRepack(ctx, actor, body.actionId, {
    incidentId: params.incidentId,
    expectedRevision: body.expectedRevision,
  });
});
