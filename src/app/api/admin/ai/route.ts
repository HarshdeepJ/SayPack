import { z } from "zod";
import { adminUsageSummary, updateAiSettings } from "@/domain/budget";
import { aiProvider } from "@/server/app";
import { actionId, route } from "@/server/http";

export const GET = route("ai.usage", ({ ctx, actor }) => {
  const provider = aiProvider();
  return { ...adminUsageSummary(ctx, actor), provider: provider.name, model: provider.model };
});

const Body = z.object({ actionId, allowanceSgd: z.number(), usdToSgd: z.number() });

export const POST = route("ai.update_settings", async ({ json, ctx, actor }) => {
  const { actionId: aid, ...input } = await json(Body);
  const provider = aiProvider();
  return { ...updateAiSettings(ctx, actor, aid, input), provider: provider.name, model: provider.model };
});
