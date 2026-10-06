import { z } from "zod";
import { MAX_PAGE_SIZE, listActivity } from "@/domain/inventory";
import { readQuery, route } from "@/server/http";

const Query = z.object({
  mine: z.enum(["1"]).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});

export const GET = route<{ moveId: string }>("move.activity", ({ request, ctx, actor, params }) => {
  const query = readQuery(request, Query);
  return listActivity(ctx, actor, { moveId: params.moveId, mineOnly: query.mine === "1", limit: query.limit });
});
