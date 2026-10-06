import { z } from "zod";
import { MAX_PAGE_SIZE, searchItems } from "@/domain/inventory";
import { recordItem } from "@/domain/inventory-mutations";
import { actionId, id, readJson, readQuery, route } from "@/server/http";

const Query = z.object({
  q: z.string().max(200).optional(),
  roomId: id.optional(),
  boxId: id.optional(),
  unboxed: z.enum(["1"]).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const GET = route<{ moveId: string }>("item.search", ({ request, ctx, actor, params }) => {
  const query = readQuery(request, Query);
  return searchItems(ctx, actor, {
    moveId: params.moveId,
    query: query.q,
    roomId: query.roomId,
    boxId: query.boxId,
    unboxed: query.unboxed === "1",
    limit: query.limit,
    offset: query.offset,
  });
});

const Body = z.object({
  actionId,
  boxId: id.nullish(),
  description: z.string(),
  category: z.string().nullish(),
  fragile: z.boolean().optional(),
  valuable: z.boolean().optional(),
});

export const POST = route<{ moveId: string }>("item.record", async ({ request, ctx, actor, params }) => {
  const { actionId: aid, ...input } = await readJson(request, Body);
  return recordItem(ctx, actor, aid, { moveId: params.moveId, ...input });
});
