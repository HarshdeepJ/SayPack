import { z } from "zod";
import { releaseMoveHold } from "@/domain/incidents";
import { actionId, revision, route } from "@/server/http";

const Body = z.object({ actionId, expectedRevision: revision, reason: z.string() });

export const POST = route<{ holdId: string }>("hold.release_move", async ({ json, ctx, actor, params }) => {
  const { actionId: aid, ...input } = await json(Body);
  return releaseMoveHold(ctx, actor, aid, { holdId: params.holdId, ...input });
});
