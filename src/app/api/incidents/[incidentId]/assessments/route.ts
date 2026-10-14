import { z } from "zod";
import { assessIncident } from "@/domain/assessment";
import { aiProvider } from "@/server/app";
import { actionId, route } from "@/server/http";

const Body = z.object({ actionId });

/** Asks the AI to check the incident's newest photos. The result never changes holds or decisions. */
export const POST = route<{ incidentId: string }>("incident.assess", async ({ json, ctx, actor, params, note }) => {
  const body = await json(Body);
  note({ actionId: body.actionId });
  return assessIncident(ctx, aiProvider(), actor, body.actionId, { incidentId: params.incidentId });
});
