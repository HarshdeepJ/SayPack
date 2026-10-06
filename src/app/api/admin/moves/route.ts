import { z } from "zod";
import { createMove, listAllMoves } from "@/domain/moves";
import { actionId, readJson, route } from "@/server/http";

export const GET = route("move.list_all", ({ ctx, actor }) => listAllMoves(ctx, actor));

const Body = z.object({
  actionId,
  label: z.string().max(120),
  source: z.string().max(200),
  destination: z.string().max(200),
});

export const POST = route("move.create", async ({ request, ctx, actor }) => {
  const { actionId: aid, ...input } = await readJson(request, Body);
  return createMove(ctx, actor, aid, input);
});
