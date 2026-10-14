// View types shared with client components. Type-only imports keep server code out of the bundle.
export type { Actor } from "@/domain/core";
export type { UserSummary } from "@/domain/identity";
export type { AdminMoveSummary, MemberSummary, MoveSummary } from "@/domain/moves";
export type {
  ActivityEntry,
  BoxView,
  HistoryEntry,
  ItemView,
  MoveHoldBrief,
  MoveOverview,
  RoomView,
} from "@/domain/inventory";
export type { ObservationView, PhotoView } from "@/domain/evidence";
export type {
  DecisionView,
  EvidenceRequestView,
  HoldView,
  IncidentDetail,
  IncidentSummary,
} from "@/domain/incidents";
export type { ItemDetail } from "@/domain/views";
export type { AiStatus, ConfirmOutcome, ProposalView, VoiceResult } from "@/domain/voice";
export type { UsageSummary } from "@/domain/budget";
export type { AssessmentView } from "@/domain/assessment";
