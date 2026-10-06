import { getMoveOverview } from "@/domain/inventory";
import { route } from "@/server/http";

export const GET = route<{ moveId: string }>("move.overview", ({ ctx, actor, params }) =>
  getMoveOverview(ctx, actor, params.moveId),
);
