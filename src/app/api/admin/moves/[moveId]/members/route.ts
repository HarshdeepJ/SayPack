import { z } from "zod";
import { addMember, removeMember } from "@/domain/moves";
import { actionId, id, route } from "@/server/http";

const Body = z.object({ actionId, userId: id, role: z.enum(["mover", "reviewer", "owner"]) });

export const POST = route<{ moveId: string }>("member.add", async ({ json, ctx, actor, params }) => {
  const { actionId: aid, ...input } = await json(Body);
  return addMember(ctx, actor, aid, { moveId: params.moveId, ...input });
});

export const DELETE = route<{ moveId: string }>("member.remove", async ({ json, ctx, actor, params }) => {
  const { actionId: aid, ...input } = await json(Body);
  return removeMember(ctx, actor, aid, { moveId: params.moveId, ...input });
});
