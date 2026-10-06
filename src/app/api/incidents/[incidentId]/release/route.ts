import { z } from "zod";
import { releaseAfterRepack } from "@/domain/incidents";
import { actionId, revision, route } from "@/server/http";

const Body = z.object({ actionId, expectedRevision: revision, reason: z.string().nullish() });

export const POST = route<{ incidentId: string }>("incident.release_after_repack", async ({ json, ctx, actor, params }) => {
  const { actionId: aid, ...input } = await json(Body);
  return releaseAfterRepack(ctx, actor, aid, { incidentId: params.incidentId, ...input });
});
