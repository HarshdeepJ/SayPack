import { sql } from "kysely";
import type { BoxStatus, ItemStatus, MoveRole } from "@/db/schema";
import { DomainError, invalid, notFound, type Actor, type Ctx } from "./core";
import { requireMovePermission } from "./moves";

export const MAX_LABEL = 40;
export const MAX_ROOM_NAME = 60;
export const MAX_DESCRIPTION = 200;
export const MAX_CATEGORY = 60;
export const MAX_PAGE_SIZE = 100;

// ---------- Views ----------

export interface RoomView {
  id: string;
  name: string;
  boxCount: number;
}

export interface BoxView {
  id: string;
  label: string;
  roomId: string | null;
  roomName: string | null;
  status: BoxStatus;
  revision: number;
  itemCount: number;
}

export interface ItemView {
  id: string;
  moveId: string;
  description: string;
  category: string | null;
  fragile: boolean;
  valuable: boolean;
  status: ItemStatus;
  revision: number;
  boxId: string | null;
  boxLabel: string | null;
  boxStatus: BoxStatus | null;
  roomName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryEntry {
  id: string;
  action: string;
  actorName: string;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface MoveOverview {
  move: { id: string; label: string; source: string; destination: string; status: string };
  roles: MoveRole[];
  canWrite: boolean;
  rooms: RoomView[];
  boxes: BoxView[];
  unboxedCount: number;
  itemCount: number;
}

// ---------- Helpers ----------

export function cleanText(value: string, max: number, reason: string, label: string): string {
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) throw invalid(reason, `Enter ${label}.`);
  if (text.length > max) throw invalid(reason, `${capitalize(label)} must be ${max} characters or fewer.`);
  return text;
}

export function cleanOptional(value: string | null | undefined, max: number, label: string): string | null {
  if (value === null || value === undefined) return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return null;
  if (text.length > max) throw invalid("too_long", `${capitalize(label)} must be ${max} characters or fewer.`);
  return text;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function itemQuery(ctx: Ctx) {
  return ctx.db.q
    .selectFrom("items")
    .leftJoin("boxes", "boxes.id", "items.box_id")
    .leftJoin("rooms", "rooms.id", "boxes.room_id")
    .select([
      "items.id",
      "items.move_id",
      "items.description",
      "items.category",
      "items.fragile",
      "items.valuable",
      "items.status",
      "items.revision",
      "items.box_id",
      "items.created_at",
      "items.updated_at",
      "boxes.label as box_label",
      "boxes.status as box_status",
      "rooms.name as room_name",
    ]);
}

type ItemRow = NonNullable<ReturnType<typeof getItemRow>>;

export function getItemRow(ctx: Ctx, itemId: string) {
  return ctx.db.get(itemQuery(ctx).where("items.id", "=", itemId));
}

export function toItemView(row: ItemRow): ItemView {
  return {
    id: row.id,
    moveId: row.move_id,
    description: row.description,
    category: row.category,
    fragile: row.fragile === 1,
    valuable: row.valuable === 1,
    status: row.status,
    revision: row.revision,
    boxId: row.box_id,
    boxLabel: row.box_label,
    boxStatus: row.box_status,
    roomName: row.room_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function loadBox(ctx: Ctx, boxId: string) {
  return ctx.db.get(ctx.db.q.selectFrom("boxes").selectAll().where("id", "=", boxId));
}

export function boxView(ctx: Ctx, boxId: string): BoxView {
  const { db } = ctx;
  const row = db.get(
    db.q
      .selectFrom("boxes")
      .leftJoin("rooms", "rooms.id", "boxes.room_id")
      .select((eb) => [
        "boxes.id",
        "boxes.label",
        "boxes.room_id",
        "boxes.status",
        "boxes.revision",
        "rooms.name as room_name",
        eb
          .selectFrom("items")
          .select(eb.fn.countAll<number>().as("n"))
          .whereRef("items.box_id", "=", "boxes.id")
          .as("item_count"),
      ])
      .where("boxes.id", "=", boxId),
  );
  if (!row) throw notFound("Box");
  return {
    id: row.id,
    label: row.label,
    roomId: row.room_id,
    roomName: row.room_name,
    status: row.status,
    revision: row.revision,
    itemCount: Number(row.item_count ?? 0),
  };
}

/** Item contents can change only while their box is open. */
export function requireBoxOpen(box: { label: string; status: BoxStatus }, verb: string) {
  if (box.status === "sealed") {
    throw new DomainError(
      "conflict",
      "box_sealed",
      `Box ${box.label} is sealed. Reopen it before you ${verb}.`,
    );
  }
  if (box.status !== "open") {
    throw new DomainError("conflict", "box_not_open", `Box ${box.label} is ${box.status} and cannot change.`);
  }
}

/** Loads a box and checks it belongs to the move; a box from another move is "not found". */
export function boxInMove(ctx: Ctx, moveId: string, boxId: string) {
  const box = loadBox(ctx, boxId);
  if (!box || box.move_id !== moveId) throw notFound("Box");
  return box;
}

// ---------- Reads ----------

export function getMoveOverview(ctx: Ctx, actor: Actor, moveId: string): MoveOverview {
  const roles = requireMovePermission(ctx, actor, moveId, "inventory.read");
  const { db } = ctx;
  const move = db.get(
    db.q
      .selectFrom("moves")
      .select(["id", "label", "source", "destination", "status"])
      .where("id", "=", moveId),
  );
  if (!move) throw notFound("Move");

  const rooms = db
    .all(
      db.q
        .selectFrom("rooms")
        .select((eb) => [
          "rooms.id",
          "rooms.name",
          eb
            .selectFrom("boxes")
            .select(eb.fn.countAll<number>().as("n"))
            .whereRef("boxes.room_id", "=", "rooms.id")
            .as("box_count"),
        ])
        .where("rooms.move_id", "=", moveId)
        .orderBy("rooms.name"),
    )
    .map((r) => ({ id: r.id, name: r.name, boxCount: Number(r.box_count ?? 0) }));

  const boxes = db
    .all(
      db.q
        .selectFrom("boxes")
        .leftJoin("rooms", "rooms.id", "boxes.room_id")
        .select((eb) => [
          "boxes.id",
          "boxes.label",
          "boxes.room_id",
          "boxes.status",
          "boxes.revision",
          "rooms.name as room_name",
          eb
            .selectFrom("items")
            .select(eb.fn.countAll<number>().as("n"))
            .whereRef("items.box_id", "=", "boxes.id")
            .as("item_count"),
        ])
        .where("boxes.move_id", "=", moveId)
        .orderBy("boxes.label"),
    )
    .map((r) => ({
      id: r.id,
      label: r.label,
      roomId: r.room_id,
      roomName: r.room_name,
      status: r.status,
      revision: r.revision,
      itemCount: Number(r.item_count ?? 0),
    }));

  const counts = db.get(
    db.q
      .selectFrom("items")
      .select((eb) => [
        eb.fn.countAll<number>().as("total"),
        eb.fn.sum<number>(eb.case().when("box_id", "is", null).then(1).else(0).end()).as("unboxed"),
      ])
      .where("move_id", "=", moveId),
  );

  return {
    move,
    roles,
    canWrite: roles.some((r) => r === "mover" || r === "reviewer"),
    rooms,
    boxes,
    itemCount: Number(counts?.total ?? 0),
    unboxedCount: Number(counts?.unboxed ?? 0),
  };
}

export interface SearchInput {
  moveId: string;
  query?: string;
  roomId?: string;
  boxId?: string;
  unboxed?: boolean;
  limit?: number;
  offset?: number;
}

/** Searches description, category, box label and room name. Paginated; newest changes first. */
export function searchItems(
  ctx: Ctx,
  actor: Actor,
  input: SearchInput,
): { items: ItemView[]; hasMore: boolean } {
  requireMovePermission(ctx, actor, input.moveId, "inventory.read");
  const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_PAGE_SIZE);
  const offset = Math.max(input.offset ?? 0, 0);

  let query = itemQuery(ctx).where("items.move_id", "=", input.moveId);
  const text = input.query?.trim();
  if (text) {
    // Treat the user's % and _ literally; SQLite LIKE is case-insensitive for ASCII.
    const pattern = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const like = (column: string) => sql<boolean>`${sql.ref(column)} LIKE ${pattern} ESCAPE '\\'`;
    query = query.where(({ or }) =>
      or([
        like("items.description"),
        like("items.category"),
        like("boxes.label"),
        like("rooms.name"),
      ]),
    );
  }
  if (input.roomId) query = query.where("boxes.room_id", "=", input.roomId);
  if (input.boxId) query = query.where("items.box_id", "=", input.boxId);
  if (input.unboxed) query = query.where("items.box_id", "is", null);

  const rows = ctx.db.all(
    query.orderBy("items.updated_at", "desc").orderBy("items.id").limit(limit + 1).offset(offset),
  );
  return { items: rows.slice(0, limit).map(toItemView), hasMore: rows.length > limit };
}

export function getItem(
  ctx: Ctx,
  actor: Actor,
  itemId: string,
): { item: ItemView; history: HistoryEntry[] } {
  const row = getItemRow(ctx, itemId);
  if (!row) throw notFound("Item");
  requireMovePermission(ctx, actor, row.move_id, "inventory.read");
  const { db } = ctx;
  const history = db
    .all(
      db.q
        .selectFrom("audit_events")
        .innerJoin("users", "users.id", "audit_events.actor_id")
        .select([
          "audit_events.id",
          "audit_events.action",
          "audit_events.before_json",
          "audit_events.after_json",
          "audit_events.created_at",
          "users.display_name",
        ])
        .where("audit_events.record_type", "=", "item")
        .where("audit_events.record_id", "=", itemId)
        .orderBy("audit_events.created_at", "desc"),
    )
    .map((e) => ({
      id: e.id,
      action: e.action,
      actorName: e.display_name,
      before: e.before_json ? JSON.parse(e.before_json) : null,
      after: e.after_json ? JSON.parse(e.after_json) : null,
      createdAt: e.created_at,
    }));
  return { item: toItemView(row), history };
}

export interface ActivityEntry extends HistoryEntry {
  recordType: string;
  recordId: string;
}

/** Recent inventory changes in a move, optionally only the actor's own (for "recent actions"). */
export function listActivity(
  ctx: Ctx,
  actor: Actor,
  input: { moveId: string; mineOnly?: boolean; limit?: number },
): ActivityEntry[] {
  requireMovePermission(ctx, actor, input.moveId, "inventory.read");
  const { db } = ctx;
  let query = db.q
    .selectFrom("audit_events")
    .innerJoin("users", "users.id", "audit_events.actor_id")
    .select([
      "audit_events.id",
      "audit_events.action",
      "audit_events.record_type",
      "audit_events.record_id",
      "audit_events.before_json",
      "audit_events.after_json",
      "audit_events.created_at",
      "users.display_name",
    ])
    .where("audit_events.move_id", "=", input.moveId)
    .where("audit_events.record_type", "in", ["item", "box", "room"]);
  if (input.mineOnly) query = query.where("audit_events.actor_id", "=", actor.id);
  return db
    .all(query.orderBy("audit_events.created_at", "desc").limit(Math.min(input.limit ?? 20, MAX_PAGE_SIZE)))
    .map((e) => ({
      id: e.id,
      action: e.action,
      recordType: e.record_type,
      recordId: e.record_id,
      actorName: e.display_name,
      before: e.before_json ? JSON.parse(e.before_json) : null,
      after: e.after_json ? JSON.parse(e.after_json) : null,
      createdAt: e.created_at,
    }));
}
