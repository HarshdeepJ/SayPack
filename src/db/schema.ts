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

export interface Schema {
  users: UsersTable;
  sessions: SessionsTable;
  moves: MovesTable;
  move_members: MoveMembersTable;
  rooms: RoomsTable;
  boxes: BoxesTable;
  items: ItemsTable;
  audit_events: AuditEventsTable;
  submitted_actions: SubmittedActionsTable;
}
