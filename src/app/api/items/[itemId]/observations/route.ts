import { z } from "zod";
import { recordObservation } from "@/domain/evidence";
import { actionId, route } from "@/server/http";

const Body = z.object({
  actionId,
  stage: z.enum(["packing", "delivery"]).default("packing"),
  condition: z.enum(["no_visible_damage", "existing_wear"]),
  note: z.string().nullish(),
});

export const POST = route<{ itemId: string }>("item.record_condition", async ({ json, ctx, actor, params }) => {
  const { actionId: aid, ...input } = await json(Body);
  return recordObservation(ctx, actor, aid, { itemId: params.itemId, ...input });
});
