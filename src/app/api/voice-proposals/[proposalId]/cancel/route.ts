import { cancelProposal } from "@/domain/voice";
import { route } from "@/server/http";

export const POST = route<{ proposalId: string }>("voice.cancel", ({ ctx, actor, params }) =>
  cancelProposal(ctx, actor, { proposalId: params.proposalId }),
);
