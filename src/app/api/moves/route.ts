import { listMyMoves } from "@/domain/moves";
import { route } from "@/server/http";

export const GET = route("move.list_mine", ({ ctx, actor }) => listMyMoves(ctx, actor));
