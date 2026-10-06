import { z } from "zod";
import { listHolds, placeMoveHold } from "@/domain/incidents";
import { actionId, id, readQuery, route } from "@/server/http";

const Query = z.object({ all: z.enum(["1"]).optional(), scope: z.enum(["item", "move"]).optional() });

export const GET = route<{ moveId: string }>("hold.list", ({ request, ctx, actor, params }) => {
  const query = readQuery(request, Query);
  return listHolds(ctx, actor, { moveId: params.moveId, activeOnly: query.all !== "1", scope: query.scope });
});

const Body = z.object({ actionId, reason: z.string(), incidentId: id.nullish() });

export const POST = route<{ moveId: string }>("hold.place_move", async ({ json, ctx, actor, params }) => {
  const { actionId: aid, ...input } = await json(Body);
  return placeMoveHold(ctx, actor, aid, { moveId: params.moveId, ...input });
});
