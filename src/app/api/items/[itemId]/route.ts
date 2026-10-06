import { z } from "zod";
import { getItemDetail } from "@/domain/views";
import { updateItem } from "@/domain/inventory-mutations";
import { actionId, revision, route } from "@/server/http";

export const GET = route<{ itemId: string }>("item.get", ({ ctx, actor, params }) =>
  getItemDetail(ctx, actor, params.itemId),
);

const Body = z.object({
  actionId,
  expectedRevision: revision,
  description: z.string().optional(),
  category: z.string().nullish(),
  fragile: z.boolean().optional(),
  valuable: z.boolean().optional(),
});

export const PATCH = route<{ itemId: string }>("item.update", async ({ json, ctx, actor, params }) => {
  const { actionId: aid, ...changes } = await json(Body);
  return updateItem(ctx, actor, aid, { itemId: params.itemId, ...changes });
});
