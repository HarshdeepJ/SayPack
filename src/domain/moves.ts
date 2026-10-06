import type { MoveRole, MoveStatus } from "@/db/schema";
import { recordAudit, runAction } from "./actions";
import { DomainError, forbidden, invalid, notFound, type Actor, type Ctx } from "./core";
import { requireAdmin } from "./identity";

export type MovePermission = "inventory.read" | "inventory.write";

const ROLE_PERMISSIONS: Record<MoveRole, readonly MovePermission[]> = {
  mover: ["inventory.read", "inventory.write"],
  reviewer: ["inventory.read", "inventory.write"],
  owner: ["inventory.read"],
};

export const MOVE_ROLES: readonly MoveRole[] = ["mover", "reviewer", "owner"];

export function rolesInMove(ctx: Ctx, actorId: string, moveId: string): MoveRole[] {
  const { db } = ctx;
  return db
    .all(
      db.q
        .selectFrom("move_members")
        .select("role")
        .where("move_id", "=", moveId)
        .where("user_id", "=", actorId),
    )
    .map((r) => r.role);
}

/**
 * Checks the actor's current membership. Call inside the mutation's transaction
 * so a membership removed a moment ago cannot authorize a write.
 * Administrators manage moves but do not see inventory unless they are members.
 */
export function requireMovePermission(
  ctx: Ctx,
  actor: Actor,
  moveId: string,
  permission: MovePermission,
): MoveRole[] {
  const roles = rolesInMove(ctx, actor.id, moveId);
  if (!roles.some((role) => ROLE_PERMISSIONS[role].includes(permission))) throw forbidden();
  return roles;
}

export interface MoveSummary {
  id: string;
  label: string;
  source: string;
  destination: string;
  status: MoveStatus;
  revision: number;
  roles: MoveRole[];
}

/** Moves the actor belongs to, with their roles in each. */
export function listMyMoves(ctx: Ctx, actor: Actor): MoveSummary[] {
  const { db } = ctx;
  const rows = db.all(
    db.q
      .selectFrom("move_members")
      .innerJoin("moves", "moves.id", "move_members.move_id")
      .select([
        "moves.id",
        "moves.label",
        "moves.source",
        "moves.destination",
        "moves.status",
        "moves.revision",
        "move_members.role",
      ])
      .where("move_members.user_id", "=", actor.id)
      .orderBy("moves.created_at", "desc"),
  );
  const byId = new Map<string, MoveSummary>();
  for (const { role, ...move } of rows) {
    const summary = byId.get(move.id) ?? { ...move, roles: [] };
    summary.roles.push(role);
    byId.set(move.id, summary);
  }
  return [...byId.values()];
}

export interface MemberSummary {
  userId: string;
  displayName: string;
  email: string;
  role: MoveRole;
}

export interface AdminMoveSummary extends Omit<MoveSummary, "roles"> {
  members: MemberSummary[];
}

export function listAllMoves(ctx: Ctx, actor: Actor): AdminMoveSummary[] {
  requireAdmin(actor);
  const { db } = ctx;
  const moves = db.all(
    db.q
      .selectFrom("moves")
      .select(["id", "label", "source", "destination", "status", "revision"])
      .orderBy("created_at", "desc"),
  );
  const members = db.all(
    db.q
      .selectFrom("move_members")
      .innerJoin("users", "users.id", "move_members.user_id")
      .select([
        "move_members.move_id",
        "move_members.user_id",
        "move_members.role",
        "users.display_name",
        "users.email",
      ])
      .orderBy("users.display_name"),
  );
  return moves.map((move) => ({
    ...move,
    members: members
      .filter((m) => m.move_id === move.id)
      .map((m) => ({ userId: m.user_id, displayName: m.display_name, email: m.email, role: m.role })),
  }));
}

export interface CreateMoveInput {
  label: string;
  source: string;
  destination: string;
}

export function createMove(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  input: CreateMoveInput,
): AdminMoveSummary {
  requireAdmin(actor);
  const fields = {
    label: input.label.trim(),
    source: input.source.trim(),
    destination: input.destination.trim(),
  };
  if (!fields.label) throw invalid("missing_label", "Enter a label for the move.");
  if (!fields.source || !fields.destination) {
    throw invalid("missing_location", "Enter both the source and the destination.");
  }
  return runAction(ctx, actor, { actionId, operation: "move.create", fingerprint: fields }, () => {
    const now = ctx.now();
    const row = {
      id: ctx.newId(),
      ...fields,
      status: "draft" as const,
      revision: 1,
      created_at: now,
      updated_at: now,
    };
    ctx.db.run(ctx.db.q.insertInto("moves").values(row));
    recordAudit(ctx, {
      moveId: row.id,
      actorId: actor.id,
      action: "move.created",
      recordType: "move",
      recordId: row.id,
      after: fields,
      actionId,
    });
    return {
      id: row.id,
      ...fields,
      status: row.status,
      revision: row.revision,
      members: [],
    };
  }).outcome;
}

export interface MembershipInput {
  moveId: string;
  userId: string;
  role: MoveRole;
}

export function addMember(ctx: Ctx, actor: Actor, actionId: string, input: MembershipInput) {
  requireAdmin(actor);
  if (!MOVE_ROLES.includes(input.role)) throw invalid("bad_role", "Unknown role.");
  return runAction(ctx, actor, { actionId, operation: "member.add", fingerprint: input }, () => {
    const { db } = ctx;
    if (!db.get(db.q.selectFrom("moves").select("id").where("id", "=", input.moveId))) {
      throw notFound("Move");
    }
    const user = db.get(
      db.q.selectFrom("users").select(["id", "active"]).where("id", "=", input.userId),
    );
    if (!user) throw notFound("User");
    if (user.active !== 1) throw invalid("inactive_user", "This user is deactivated.");
    if (rolesInMove(ctx, input.userId, input.moveId).includes(input.role)) {
      throw new DomainError("conflict", "member_exists", "This user already has that role in the move.");
    }
    db.run(
      db.q.insertInto("move_members").values({
        move_id: input.moveId,
        user_id: input.userId,
        role: input.role,
        created_at: ctx.now(),
      }),
    );
    recordAudit(ctx, {
      moveId: input.moveId,
      actorId: actor.id,
      action: "member.added",
      recordType: "move_member",
      recordId: `${input.userId}:${input.role}`,
      after: input,
      actionId,
    });
    return input;
  }).outcome;
}

/** Takes effect on the member's next request: every check reads current membership. */
export function removeMember(ctx: Ctx, actor: Actor, actionId: string, input: MembershipInput) {
  requireAdmin(actor);
  return runAction(ctx, actor, { actionId, operation: "member.remove", fingerprint: input }, () => {
    const { db } = ctx;
    const result = db.run(
      db.q
        .deleteFrom("move_members")
        .where("move_id", "=", input.moveId)
        .where("user_id", "=", input.userId)
        .where("role", "=", input.role),
    );
    if (result.changes === 0) throw notFound("Membership");
    recordAudit(ctx, {
      moveId: input.moveId,
      actorId: actor.id,
      action: "member.removed",
      recordType: "move_member",
      recordId: `${input.userId}:${input.role}`,
      before: input,
      actionId,
    });
    return input;
  }).outcome;
}
