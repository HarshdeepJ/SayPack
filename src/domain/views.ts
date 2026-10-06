import type { Actor, Ctx } from "./core";
import { listItemBaselinePhotos, listObservations, type ObservationView, type PhotoView } from "./evidence";
import { activeHolds, listItemIncidents, type HoldView, type IncidentSummary } from "./incidents";
import { getItem, type HistoryEntry, type ItemView } from "./inventory";

export interface ItemDetail {
  item: ItemView;
  history: HistoryEntry[];
  observations: ObservationView[];
  baselinePhotos: PhotoView[];
  incidents: IncidentSummary[];
  /** Active holds on this item, plus any active whole-move holds. */
  holds: HoldView[];
}

/** Everything a member may see about one item. getItem performs the permission check. */
export function getItemDetail(ctx: Ctx, actor: Actor, itemId: string): ItemDetail {
  const { item, history } = getItem(ctx, actor, itemId);
  return {
    item,
    history,
    observations: listObservations(ctx, item.id),
    baselinePhotos: listItemBaselinePhotos(ctx, item.id),
    incidents: listItemIncidents(ctx, item.id),
    holds: [
      ...activeHolds(ctx, { moveId: item.moveId, itemId: item.id }),
      ...activeHolds(ctx, { moveId: item.moveId, scope: "move" }),
    ],
  };
}
