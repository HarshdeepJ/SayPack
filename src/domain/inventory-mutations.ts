import { sql } from "kysely";
import type { BoxStatus } from "@/db/schema";
import { recordAudit, runAction } from "./actions";
import { DomainError, notFound, staleRevision, type Actor, type Ctx } from "./core";
import {
  MAX_CATEGORY,
  MAX_DESCRIPTION,
  MAX_LABEL,
  MAX_ROOM_NAME,
  boxInMove,
  boxView,
  cleanOptional,
  cleanText,
  getItemRow,
  loadBox,
  requireBoxOpen,
  toItemView,
  type BoxView,
  type ItemView,
  type RoomView,
} from "./inventory";
import { requireMovePermission } from "./moves";

export function createRoom(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  input: { moveId: string; name: string },
): RoomView {
  const name = cleanText(input.name, MAX_ROOM_NAME, "bad_room_name", "a room name");
  return runAction(
    ctx,
    actor,
    { actionId, operation: "room.create", fingerprint: { moveId: input.moveId, name } },
    () => {
      requireMovePermission(ctx, actor, input.moveId, "inventory.write");
      const { db } = ctx;
      const clash = db.get(
        db.q
          .selectFrom("rooms")
          .select("id")
          .where("move_id", "=", input.moveId)
          .where(sql<boolean>`name = ${name} COLLATE NOCASE`),
      );
      if (clash) throw new DomainError("conflict", "room_exists", `A room named "${name}" already exists.`);
      const id = ctx.newId();
      db.run(db.q.insertInto("rooms").values({ id, move_id: input.moveId, name, created_at: ctx.now() }));
      recordAudit(ctx, {
        moveId: input.moveId,
        actorId: actor.id,
        action: "room.created",
        recordType: "room",
        recordId: id,
        after: { name },
        actionId,
      });
      return { id, name, boxCount: 0 };
    },
  ).outcome;
}

export function createBox(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  input: { moveId: string; label: string; roomId?: string | null },
): BoxView {
  const label = cleanText(input.label, MAX_LABEL, "bad_box_label", "a box label");
  const roomId = input.roomId || null;
  return runAction(
    ctx,
    actor,
    { actionId, operation: "box.create", fingerprint: { moveId: input.moveId, label, roomId } },
    () => {
      requireMovePermission(ctx, actor, input.moveId, "inventory.write");
      const { db } = ctx;
      if (roomId) {
        const room = db.get(db.q.selectFrom("rooms").select("move_id").where("id", "=", roomId));
        if (!room || room.move_id !== input.moveId) throw notFound("Room");
      }
      const clash = db.get(
        db.q
          .selectFrom("boxes")
          .select("id")
          .where("move_id", "=", input.moveId)
          .where(sql<boolean>`label = ${label} COLLATE NOCASE`),
      );
      if (clash) {
        throw new DomainError(
          "conflict",
          "box_label_exists",
          `Box label "${label}" is already used in this move.`,
        );
      }
      const id = ctx.newId();
      const now = ctx.now();
      db.run(
        db.q.insertInto("boxes").values({
          id,
          move_id: input.moveId,
          room_id: roomId,
          label,
          status: "open",
          revision: 1,
          created_at: now,
          updated_at: now,
        }),
      );
      recordAudit(ctx, {
        moveId: input.moveId,
        actorId: actor.id,
        action: "box.created",
        recordType: "box",
        recordId: id,
        after: { label, roomId },
        actionId,
      });
      return boxView(ctx, id);
    },
  ).outcome;
}

interface BoxStatusInput {
  boxId: string;
  expectedRevision: number;
}

function changeBoxStatus(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  input: BoxStatusInput,
  transition: { from: BoxStatus; to: BoxStatus; operation: string; event: string },
): BoxView {
  return runAction(ctx, actor, { actionId, operation: transition.operation, fingerprint: input }, () => {
    const box = loadBox(ctx, input.boxId);
    if (!box) throw notFound("Box");
    requireMovePermission(ctx, actor, box.move_id, "inventory.write");
    if (box.revision !== input.expectedRevision) throw staleRevision(boxView(ctx, box.id));
    if (box.status !== transition.from) {
      throw new DomainError(
        "conflict",
        "bad_box_status",
        `Box ${box.label} is ${box.status}, not ${transition.from}.`,
      );
    }
    ctx.db.run(
      ctx.db.q
        .updateTable("boxes")
        .set({ status: transition.to, revision: box.revision + 1, updated_at: ctx.now() })
        .where("id", "=", box.id),
    );
    recordAudit(ctx, {
      moveId: box.move_id,
      actorId: actor.id,
      action: transition.event,
      recordType: "box",
      recordId: box.id,
      before: { status: transition.from },
      after: { status: transition.to },
      actionId,
    });
    return boxView(ctx, box.id);
  }).outcome;
}

export function sealBox(ctx: Ctx, actor: Actor, actionId: string, input: BoxStatusInput): BoxView {
  return changeBoxStatus(ctx, actor, actionId, input, {
    from: "open",
    to: "sealed",
    operation: "box.seal",
    event: "box.sealed",
  });
}

/** Reopening stays allowed while an item inside is held; holds arrive in milestone 2. */
export function reopenBox(ctx: Ctx, actor: Actor, actionId: string, input: BoxStatusInput): BoxView {
  return changeBoxStatus(ctx, actor, actionId, input, {
    from: "sealed",
    to: "open",
    operation: "box.reopen",
    event: "box.reopened",
  });
}

export interface RecordItemInput {
  moveId: string;
  boxId?: string | null;
  description: string;
  category?: string | null;
  fragile?: boolean;
  valuable?: boolean;
}

export function recordItem(ctx: Ctx, actor: Actor, actionId: string, input: RecordItemInput): ItemView {
  const fields = {
    moveId: input.moveId,
    boxId: input.boxId || null,
    description: cleanText(input.description, MAX_DESCRIPTION, "bad_description", "a description"),
    category: cleanOptional(input.category, MAX_CATEGORY, "the category"),
    fragile: input.fragile ?? false,
    valuable: input.valuable ?? false,
  };
  return runAction(ctx, actor, { actionId, operation: "item.record", fingerprint: fields }, () => {
    requireMovePermission(ctx, actor, fields.moveId, "inventory.write");
    if (fields.boxId) requireBoxOpen(boxInMove(ctx, fields.moveId, fields.boxId), "add items");
    const id = ctx.newId();
    const now = ctx.now();
    ctx.db.run(
      ctx.db.q.insertInto("items").values({
        id,
        move_id: fields.moveId,
        box_id: fields.boxId,
        description: fields.description,
        category: fields.category,
        fragile: fields.fragile ? 1 : 0,
        valuable: fields.valuable ? 1 : 0,
        status: "recorded",
        revision: 1,
        created_by: actor.id,
        created_at: now,
        updated_at: now,
      }),
    );
    const { moveId, ...after } = fields;
    recordAudit(ctx, {
      moveId,
      actorId: actor.id,
      action: "item.recorded",
      recordType: "item",
      recordId: id,
      after,
      actionId,
    });
    return toItemView(getItemRow(ctx, id)!);
  }).outcome;
}

export interface UpdateItemInput {
  itemId: string;
  expectedRevision: number;
  description?: string;
  category?: string | null;
  fragile?: boolean;
  valuable?: boolean;
}

type ItemChanges = Partial<Pick<ItemView, "description" | "category" | "fragile" | "valuable">>;

/** Edits descriptive fields. History keeps the previous value of every changed field. */
export function updateItem(ctx: Ctx, actor: Actor, actionId: string, input: UpdateItemInput): ItemView {
  const changes: ItemChanges = {};
  if (input.description !== undefined) {
    changes.description = cleanText(input.description, MAX_DESCRIPTION, "bad_description", "a description");
  }
  if (input.category !== undefined) {
    changes.category = cleanOptional(input.category, MAX_CATEGORY, "the category");
  }
  if (input.fragile !== undefined) changes.fragile = input.fragile;
  if (input.valuable !== undefined) changes.valuable = input.valuable;

  const fingerprint = { itemId: input.itemId, expectedRevision: input.expectedRevision, changes };
  return runAction(ctx, actor, { actionId, operation: "item.update", fingerprint }, () => {
    const row = getItemRow(ctx, input.itemId);
    if (!row) throw notFound("Item");
    requireMovePermission(ctx, actor, row.move_id, "inventory.write");
    if (row.revision !== input.expectedRevision) throw staleRevision(toItemView(row));
    if (row.box_id) requireBoxOpen({ label: row.box_label!, status: row.box_status! }, "edit its items");

    const current = toItemView(row);
    const before: ItemChanges = {};
    const after: ItemChanges = {};
    for (const key of Object.keys(changes) as (keyof ItemChanges)[]) {
      if (current[key] !== changes[key]) {
        Object.assign(before, { [key]: current[key] });
        Object.assign(after, { [key]: changes[key] });
      }
    }
    if (Object.keys(after).length === 0) return current;

    ctx.db.run(
      ctx.db.q
        .updateTable("items")
        .set({
          ...(after.description !== undefined && { description: after.description }),
          ...("category" in after && { category: after.category ?? null }),
          ...(after.fragile !== undefined && { fragile: after.fragile ? 1 : 0 }),
          ...(after.valuable !== undefined && { valuable: after.valuable ? 1 : 0 }),
          revision: row.revision + 1,
          updated_at: ctx.now(),
        })
        .where("id", "=", row.id),
    );
    recordAudit(ctx, {
      moveId: row.move_id,
      actorId: actor.id,
      action: "item.updated",
      recordType: "item",
      recordId: row.id,
      before,
      after,
      actionId,
    });
    return toItemView(getItemRow(ctx, row.id)!);
  }).outcome;
}

/** Moves an item to another box in the same move, or out of any box (boxId null). */
export function assignItemToBox(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  input: { itemId: string; expectedRevision: number; boxId: string | null },
): ItemView {
  const fingerprint = {
    itemId: input.itemId,
    expectedRevision: input.expectedRevision,
    boxId: input.boxId || null,
  };
  return runAction(ctx, actor, { actionId, operation: "item.assign_box", fingerprint }, () => {
    const row = getItemRow(ctx, input.itemId);
    if (!row) throw notFound("Item");
    requireMovePermission(ctx, actor, row.move_id, "inventory.write");
    if (row.revision !== input.expectedRevision) throw staleRevision(toItemView(row));
    if (row.box_id === fingerprint.boxId) return toItemView(row);

    if (row.box_id) requireBoxOpen({ label: row.box_label!, status: row.box_status! }, "remove items");
    const target = fingerprint.boxId ? boxInMove(ctx, row.move_id, fingerprint.boxId) : null;
    if (target) requireBoxOpen(target, "add items");

    ctx.db.run(
      ctx.db.q
        .updateTable("items")
        .set({ box_id: fingerprint.boxId, revision: row.revision + 1, updated_at: ctx.now() })
        .where("id", "=", row.id),
    );
    recordAudit(ctx, {
      moveId: row.move_id,
      actorId: actor.id,
      action: "item.box_assigned",
      recordType: "item",
      recordId: row.id,
      before: { boxId: row.box_id, boxLabel: row.box_label },
      after: { boxId: fingerprint.boxId, boxLabel: target?.label ?? null },
      actionId,
    });
    return toItemView(getItemRow(ctx, row.id)!);
  }).outcome;
}
