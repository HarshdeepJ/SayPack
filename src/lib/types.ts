// View types shared with client components. Type-only imports keep server code out of the bundle.
export type { Actor } from "@/domain/core";
export type { UserSummary } from "@/domain/identity";
export type { AdminMoveSummary, MemberSummary, MoveSummary } from "@/domain/moves";
export type {
  ActivityEntry,
  BoxView,
  HistoryEntry,
  ItemView,
  MoveOverview,
  RoomView,
} from "@/domain/inventory";
