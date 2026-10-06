import { z } from "zod";
import { listIncidents, reportDamage } from "@/domain/incidents";
import { actionId, id, readQuery, route } from "@/server/http";

const Query = z.object({ filter: z.enum(["unresolved", "resolved", "all"]).optional() });

export const GET = route<{ moveId: string }>("incident.list", ({ request, ctx, actor, params }) =>
  listIncidents(ctx, actor, { moveId: params.moveId, filter: readQuery(request, Query).filter }),
);

const Body = z.object({
  actionId,
  itemId: id.nullish(),
  report: z.string(),
  stage: z.enum(["packing", "delivery"]).optional(),
});

export const POST = route<{ moveId: string }>("incident.report", async ({ json, ctx, actor, params }) => {
  const { actionId: aid, ...input } = await json(Body);
  return reportDamage(ctx, actor, aid, { moveId: params.moveId, ...input });
});
