// Row types for Kysely. Keep in step with migrations/*.sql.

export type MoveStatus = "draft" | "packing" | "in_transit" | "delivered" | "completed";
export type MoveRole = "mover" | "reviewer" | "owner";
export type BoxStatus = "open" | "sealed" | "delivered";
export type ItemStatus = "recorded" | "packed" | "delivered";

export interface UsersTable {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  is_admin: number;
  active: number;
  created_at: string;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface MovesTable {
  id: string;
  label: string;
  source: string;
  destination: string;
  status: MoveStatus;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface MoveMembersTable {
  move_id: string;
  user_id: string;
  role: MoveRole;
  created_at: string;
}

export interface RoomsTable {
  id: string;
  move_id: string;
  name: string;
  created_at: string;
}

export interface BoxesTable {
  id: string;
  move_id: string;
  room_id: string | null;
  label: string;
  status: BoxStatus;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface ItemsTable {
  id: string;
  move_id: string;
  box_id: string | null;
  description: string;
  category: string | null;
  fragile: number;
  valuable: number;
  status: ItemStatus;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface AuditEventsTable {
  id: string;
  move_id: string | null;
  actor_id: string;
  action: string;
  record_type: string;
  record_id: string;
  before_json: string | null;
  after_json: string | null;
  action_id: string | null;
  created_at: string;
}

export interface SubmittedActionsTable {
  action_id: string;
  user_id: string;
  operation: string;
  payload_hash: string;
  status: "pending" | "committed" | "failed";
  outcome_json: string | null;
  created_at: string;
  completed_at: string | null;
}

export type Stage = "packing" | "delivery";
export type ObservedCondition = "no_visible_damage" | "existing_wear";
export type IncidentStatus = "open" | "escalated" | "resolved";
export type DecisionAction = "continue" | "repack" | "escalate" | "close";
export type EvidenceRequestStatus = "open" | "fulfilled" | "cancelled";
export type PhotoKind = "baseline" | "incident";

export interface ConditionObservationsTable {
  id: string;
  move_id: string;
  item_id: string;
  stage: Stage;
  condition: ObservedCondition;
  note: string | null;
  recorded_by: string;
  created_at: string;
}

export interface DamageIncidentsTable {
  id: string;
  move_id: string;
  item_id: string | null;
  stage: Stage;
  report: string;
  status: IncidentStatus;
  latest_decision: DecisionAction | null;
  repacked_at: string | null;
  repacked_by: string | null;
  reported_by: string;
  revision: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface HoldsTable {
  id: string;
  move_id: string;
  item_id: string | null;
  incident_id: string | null;
  reason: string;
  created_by: string;
  created_at: string;
  released_at: string | null;
  released_by: string | null;
  release_reason: string | null;
  revision: number;
}

export interface EvidenceRequestsTable {
  id: string;
  move_id: string;
  incident_id: string;
  request_text: string;
  status: EvidenceRequestStatus;
  requested_by: string;
  closed_by: string | null;
  revision: number;
  created_at: string;
  closed_at: string | null;
}

export interface DecisionsTable {
  id: string;
  incident_id: string;
  reviewer_id: string;
  action: DecisionAction;
  reason: string | null;
  created_at: string;
}

export interface PhotosTable {
  id: string;
  move_id: string;
  kind: PhotoKind;
  item_id: string | null;
  incident_id: string | null;
  evidence_request_id: string | null;
  storage_key: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  uploaded_by: string;
  created_at: string;
}

export type VoiceOperation = "record_item" | "assign_item_to_box" | "record_condition" | "report_damage";

export interface VoiceRequestsTable {
  id: string;
  move_id: string;
  user_id: string;
  input_kind: "audio" | "text";
  input_hash: string;
  audio_seconds: number | null;
  context_json: string;
  clarifies_request_id: string | null;
  status: "pending" | "proposed" | "clarification" | "failed";
  transcript: string | null;
  result_json: string | null;
  error_reason: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface VoiceProposalsTable {
  id: string;
  request_id: string;
  move_id: string;
  user_id: string;
  operation: VoiceOperation;
  args_json: string;
  readback: string;
  context_box_id: string | null;
  status: "pending" | "confirmed" | "cancelled" | "expired";
  outcome_json: string | null;
  expires_at: string;
  created_at: string;
  decided_at: string | null;
}

export interface AiUsageTable {
  id: string;
  request_id: string;
  operation: string;
  model: string;
  status: "reserved" | "settled" | "uncertain" | "released";
  reserved_micro_sgd: number;
  cost_micro_sgd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  pricing_version: string;
  usd_to_sgd: number;
  created_at: string;
  settled_at: string | null;
}

export interface AiSettingsTable {
  id: number;
  allowance_micro_sgd: number;
  usd_to_sgd: number;
  consecutive_failures: number;
  breaker_open_until: string | null;
  updated_at: string;
  updated_by: string | null;
}

export type AssessmentVerdict = "damage_visible" | "no_damage_visible" | "inconclusive";

export interface AiAssessmentsTable {
  id: string;
  incident_id: string;
  move_id: string;
  requested_by: string;
  status: "pending" | "completed" | "failed";
  photo_ids_json: string;
  baseline_photo_id: string | null;
  verdict: AssessmentVerdict | null;
  result_json: string | null;
  model: string;
  error_reason: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface Schema {
  ai_assessments: AiAssessmentsTable;
  voice_requests: VoiceRequestsTable;
  voice_proposals: VoiceProposalsTable;
  ai_usage: AiUsageTable;
  ai_settings: AiSettingsTable;
  users: UsersTable;
  sessions: SessionsTable;
  moves: MovesTable;
  move_members: MoveMembersTable;
  rooms: RoomsTable;
  boxes: BoxesTable;
  items: ItemsTable;
  audit_events: AuditEventsTable;
  submitted_actions: SubmittedActionsTable;
  condition_observations: ConditionObservationsTable;
  damage_incidents: DamageIncidentsTable;
  holds: HoldsTable;
  evidence_requests: EvidenceRequestsTable;
  decisions: DecisionsTable;
  photos: PhotosTable;
}
