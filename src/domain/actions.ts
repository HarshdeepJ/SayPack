import { DomainError, sha256, stableStringify, type Actor, type Ctx } from "./core";

export interface ActionRequest {
  actionId: string;
  operation: string;
  /** Fields that define the mutation. Leave secrets out; they would be hashed and kept. */
  fingerprint: unknown;
}

export interface ActionResult<T> {
  outcome: T;
  replayed: boolean;
}

/**
 * Runs a domain mutation at most once per action ID.
 *
 * The check, the mutation and the recorded outcome share one write transaction,
 * so a concurrent retry either sees the committed outcome or waits for it.
 * A failed mutation rolls back and records nothing; retrying re-evaluates it.
 */
export function runAction<T>(
  ctx: Ctx,
  actor: Actor,
  request: ActionRequest,
  mutate: () => T,
): ActionResult<T> {
  const { db } = ctx;
  const payloadHash = sha256(stableStringify({ op: request.operation, f: request.fingerprint }));

  return db.transaction(() => {
    const existing = db.get(
      db.q.selectFrom("submitted_actions").selectAll().where("action_id", "=", request.actionId),
    );
    if (existing) {
      if (
        existing.user_id !== actor.id ||
        existing.operation !== request.operation ||
        existing.payload_hash !== payloadHash
      ) {
        throw new DomainError(
          "conflict",
          "action_id_reused",
          "This action ID was already used for a different request.",
        );
      }
      if (existing.status !== "committed" || existing.outcome_json === null) {
        throw new DomainError("conflict", "action_in_progress", "This action is still being processed.");
      }
      return { outcome: JSON.parse(existing.outcome_json) as T, replayed: true };
    }

    const outcome = mutate();
    const now = ctx.now();
    db.run(
      db.q.insertInto("submitted_actions").values({
        action_id: request.actionId,
        user_id: actor.id,
        operation: request.operation,
        payload_hash: payloadHash,
        status: "committed",
        outcome_json: JSON.stringify(outcome),
        created_at: now,
        completed_at: now,
      }),
    );
    return { outcome, replayed: false };
  });
}

/**
 * Checks for an earlier submission without running anything. Uploads call this
 * before writing a file, so a retried upload does not store the photo twice.
 * Returns the recorded outcome for a matching replay, or null when the ID is new.
 */
export function peekAction<T>(ctx: Ctx, actor: Actor, request: ActionRequest): T | null {
  const { db } = ctx;
  const existing = db.get(
    db.q.selectFrom("submitted_actions").selectAll().where("action_id", "=", request.actionId),
  );
  if (!existing) return null;
  const payloadHash = sha256(stableStringify({ op: request.operation, f: request.fingerprint }));
  if (
    existing.user_id !== actor.id ||
    existing.operation !== request.operation ||
    existing.payload_hash !== payloadHash
  ) {
    throw new DomainError("conflict", "action_id_reused", "This action ID was already used for a different request.");
  }
  if (existing.status !== "committed" || existing.outcome_json === null) {
    throw new DomainError("conflict", "action_in_progress", "This action is still being processed.");
  }
  return JSON.parse(existing.outcome_json) as T;
}

export function recordAudit(
  ctx: Ctx,
  event: {
    moveId: string | null;
    actorId: string;
    action: string;
    recordType: string;
    recordId: string;
    before?: unknown;
    after?: unknown;
    actionId?: string;
  },
) {
  ctx.db.run(
    ctx.db.q.insertInto("audit_events").values({
      id: ctx.newId(),
      move_id: event.moveId,
      actor_id: event.actorId,
      action: event.action,
      record_type: event.recordType,
      record_id: event.recordId,
      before_json: event.before === undefined ? null : JSON.stringify(event.before),
      after_json: event.after === undefined ? null : JSON.stringify(event.after),
      action_id: event.actionId ?? null,
      created_at: ctx.now(),
    }),
  );
}
