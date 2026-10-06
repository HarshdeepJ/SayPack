import { z } from "zod";
import { getItem } from "@/domain/inventory";
import { updateItem } from "@/domain/inventory-mutations";
import { actionId, readJson, revision, route } from "@/server/http";

export const GET = route<{ itemId: string }>("item.get", ({ ctx, actor, params }) =>
  getItem(ctx, actor, params.itemId),
);

const Body = z.object({
  actionId,
  expectedRevision: revision,
  description: z.string().optional(),
  category: z.string().nullish(),
  fragile: z.boolean().optional(),
  valuable: z.boolean().optional(),
});

export const PATCH = route<{ itemId: string }>("item.update", async ({ request, ctx, actor, params }) => {
  const { actionId: aid, ...changes } = await readJson(request, Body);
  return updateItem(ctx, actor, aid, { itemId: params.itemId, ...changes });
});
