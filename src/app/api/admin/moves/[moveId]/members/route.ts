import { z } from "zod";
import { addMember, removeMember } from "@/domain/moves";
import { actionId, id, readJson, route } from "@/server/http";

const Body = z.object({ actionId, userId: id, role: z.enum(["mover", "reviewer", "owner"]) });

export const POST = route<{ moveId: string }>("member.add", async ({ request, ctx, actor, params }) => {
  const { actionId: aid, ...input } = await readJson(request, Body);
  return addMember(ctx, actor, aid, { moveId: params.moveId, ...input });
});

export const DELETE = route<{ moveId: string }>("member.remove", async ({ request, ctx, actor, params }) => {
  const { actionId: aid, ...input } = await readJson(request, Body);
  return removeMember(ctx, actor, aid, { moveId: params.moveId, ...input });
});
