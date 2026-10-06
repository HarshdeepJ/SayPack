import { z } from "zod";
import { identifyIncidentItem } from "@/domain/incidents";
import { actionId, id, revision, route } from "@/server/http";

const Body = z.object({ actionId, expectedRevision: revision, itemId: id });

export const POST = route<{ incidentId: string }>("incident.identify_item", async ({ json, ctx, actor, params }) => {
  const { actionId: aid, ...input } = await json(Body);
  return identifyIncidentItem(ctx, actor, aid, { incidentId: params.incidentId, ...input });
});
