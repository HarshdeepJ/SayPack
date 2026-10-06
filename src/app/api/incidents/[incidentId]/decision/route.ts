import { z } from "zod";
import { decideIncident } from "@/domain/incidents";
import { actionId, revision, route } from "@/server/http";

const Body = z.object({
  actionId,
  expectedRevision: revision,
  action: z.enum(["continue", "repack", "escalate", "close"]),
  reason: z.string().nullish(),
});

export const POST = route<{ incidentId: string }>("incident.decide", async ({ json, ctx, actor, params }) => {
  const { actionId: aid, ...input } = await json(Body);
  return decideIncident(ctx, actor, aid, { incidentId: params.incidentId, ...input });
});
