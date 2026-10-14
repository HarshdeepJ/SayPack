import { z } from "zod";
import { confirmProposal } from "@/domain/voice";
import { actionId, id, route } from "@/server/http";

const Body = z.object({ actionId, contextBoxId: id.nullable() });

export const POST = route<{ proposalId: string }>("voice.confirm", async ({ json, ctx, actor, params }) => {
  const body = await json(Body);
  return confirmProposal(ctx, actor, body.actionId, { proposalId: params.proposalId, contextBoxId: body.contextBoxId });
});
