import type { ObservedCondition, PhotoKind, Stage } from "@/db/schema";
import { peekAction, recordAudit, runAction } from "./actions";
import { DomainError, invalid, notFound, staleRevision, type Actor, type Ctx } from "./core";
import { cleanOptional, getItemRow, requireBoxOpen, toItemView, type ItemView } from "./inventory";
import { requireMovePermission } from "./moves";

export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
export const PHOTO_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type PhotoMediaType = (typeof PHOTO_MEDIA_TYPES)[number];

const MAX_NOTE = 500;

// ---------- Views ----------

export interface PhotoView {
  id: string;
  kind: PhotoKind;
  itemId: string | null;
  incidentId: string | null;
  evidenceRequestId: string | null;
  mediaType: string;
  sizeBytes: number;
  uploadedByName: string;
  createdAt: string;
  /** False when the committed file is missing from disk; such a photo is not valid evidence. */
  available: boolean;
}

export interface ObservationView {
  id: string;
  stage: Stage;
  condition: ObservedCondition;
  note: string | null;
  recordedByName: string;
  createdAt: string;
}

function photoQuery(ctx: Ctx) {
  return ctx.db.q
    .selectFrom("photos")
    .innerJoin("users", "users.id", "photos.uploaded_by")
    .select([
      "photos.id",
      "photos.kind",
      "photos.item_id",
      "photos.incident_id",
      "photos.evidence_request_id",
      "photos.storage_key",
      "photos.media_type",
      "photos.size_bytes",
      "photos.created_at",
      "users.display_name",
    ]);
}

interface PhotoRow {
  id: string;
  kind: PhotoKind;
  item_id: string | null;
  incident_id: string | null;
  evidence_request_id: string | null;
  storage_key: string;
  media_type: string;
  size_bytes: number;
  created_at: string;
  display_name: string;
}

function toPhotoView(ctx: Ctx, row: PhotoRow): PhotoView {
  return {
    id: row.id,
    kind: row.kind,
    itemId: row.item_id,
    incidentId: row.incident_id,
    evidenceRequestId: row.evidence_request_id,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    uploadedByName: row.display_name,
    createdAt: row.created_at,
    available: ctx.photos.exists(row.storage_key),
  };
}

export function listItemBaselinePhotos(ctx: Ctx, itemId: string): PhotoView[] {
  return ctx.db
    .all(
      photoQuery(ctx)
        .where("photos.item_id", "=", itemId)
        .where("photos.kind", "=", "baseline")
        .orderBy("photos.created_at"),
    )
    .map((row) => toPhotoView(ctx, row));
}

export function listIncidentPhotos(ctx: Ctx, incidentId: string): PhotoView[] {
  return ctx.db
    .all(photoQuery(ctx).where("photos.incident_id", "=", incidentId).orderBy("photos.created_at"))
    .map((row) => toPhotoView(ctx, row));
}

export function listObservations(ctx: Ctx, itemId: string): ObservationView[] {
  const { db } = ctx;
  return db
    .all(
      db.q
        .selectFrom("condition_observations")
        .innerJoin("users", "users.id", "condition_observations.recorded_by")
        .select([
          "condition_observations.id",
          "condition_observations.stage",
          "condition_observations.condition",
          "condition_observations.note",
          "condition_observations.created_at",
          "users.display_name",
        ])
        .where("condition_observations.item_id", "=", itemId)
        .orderBy("condition_observations.created_at", "desc"),
    )
    .map((o) => ({
      id: o.id,
      stage: o.stage,
      condition: o.condition,
      note: o.note,
      recordedByName: o.display_name,
      createdAt: o.created_at,
    }));
}

/** Where a photo file may be read from, after checking the actor may see it. */
export function photoForDownload(
  ctx: Ctx,
  actor: Actor,
  photoId: string,
): { storageKey: string; mediaType: string } {
  const row = ctx.db.get(
    ctx.db.q.selectFrom("photos").select(["move_id", "storage_key", "media_type"]).where("id", "=", photoId),
  );
  if (!row) throw notFound("Photo");
  requireMovePermission(ctx, actor, row.move_id, "inventory.read");
  if (!ctx.photos.exists(row.storage_key)) {
    throw new DomainError("not_found", "photo_file_missing", "This photo's file is missing from storage.");
  }
  return { storageKey: row.storage_key, mediaType: row.media_type };
}

// ---------- Observations and packing ----------

export function recordObservation(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  input: { itemId: string; stage: Stage; condition: ObservedCondition; note?: string | null },
): ObservationView {
  const fields = { ...input, note: cleanOptional(input.note, MAX_NOTE, "the note") };
  return runAction(ctx, actor, { actionId, operation: "observation.record", fingerprint: fields }, () => {
    const item = getItemRow(ctx, fields.itemId);
    if (!item) throw notFound("Item");
    requireMovePermission(ctx, actor, item.move_id, "inventory.write");
    const id = ctx.newId();
    const now = ctx.now();
    ctx.db.run(
      ctx.db.q.insertInto("condition_observations").values({
        id,
        move_id: item.move_id,
        item_id: item.id,
        stage: fields.stage,
        condition: fields.condition,
        note: fields.note,
        recorded_by: actor.id,
        created_at: now,
      }),
    );
    recordAudit(ctx, {
      moveId: item.move_id,
      actorId: actor.id,
      action: "item.condition_recorded",
      recordType: "item",
      recordId: item.id,
      after: { stage: fields.stage, condition: fields.condition, note: fields.note },
      actionId,
    });
    return {
      id,
      stage: fields.stage,
      condition: fields.condition,
      note: fields.note,
      recordedByName: actor.displayName,
      createdAt: now,
    };
  }).outcome;
}

/** True when the item has at least one baseline photo whose file is present. */
function hasAvailableBaseline(ctx: Ctx, itemId: string) {
  return listItemBaselinePhotos(ctx, itemId).some((p) => p.available);
}

/**
 * Marks an item packed. Blocked by an active hold on the item or the whole move,
 * and, for fragile or valuable items, by a missing baseline photo.
 */
export function markPacked(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  input: { itemId: string; expectedRevision: number },
): ItemView {
  return runAction(ctx, actor, { actionId, operation: "item.mark_packed", fingerprint: input }, () => {
    const row = getItemRow(ctx, input.itemId);
    if (!row) throw notFound("Item");
    requireMovePermission(ctx, actor, row.move_id, "inventory.write");
    const item = toItemView(row);
    if (item.revision !== input.expectedRevision) throw staleRevision(item);
    if (item.status !== "recorded") {
      throw new DomainError("conflict", "bad_item_status", `This item is already ${item.status}.`);
    }
    if (!item.boxId) throw invalid("no_box", "Put the item in a box before marking it packed.");
    requireBoxOpen({ label: item.boxLabel!, status: item.boxStatus! }, "pack items into it");
    if (item.onHold) {
      throw new DomainError("conflict", "item_on_hold", "This item is on hold. Follow the reviewer's instruction first.");
    }
    if (item.moveOnHold) {
      throw new DomainError("conflict", "move_on_hold", "The whole move is on hold. Packing cannot progress.");
    }
    if ((item.fragile || item.valuable) && !hasAvailableBaseline(ctx, item.id)) {
      throw invalid("baseline_required", "Fragile and valuable items need a baseline photo before they are packed.");
    }
    ctx.db.run(
      ctx.db.q
        .updateTable("items")
        .set({ status: "packed", revision: item.revision + 1, updated_at: ctx.now() })
        .where("id", "=", item.id),
    );
    recordAudit(ctx, {
      moveId: item.moveId,
      actorId: actor.id,
      action: "item.packed",
      recordType: "item",
      recordId: item.id,
      before: { status: "recorded" },
      after: { status: "packed" },
      actionId,
    });
    return toItemView(getItemRow(ctx, item.id)!);
  }).outcome;
}

// ---------- Photos ----------

export interface PhotoTarget {
  kind: PhotoKind;
  itemId?: string | null;
  incidentId?: string | null;
  evidenceRequestId?: string | null;
}

export interface StoredFile {
  photoId: string;
  storageKey: string;
  mediaType: PhotoMediaType;
  sizeBytes: number;
  sha256: string;
}

function photoFingerprint(target: PhotoTarget, sha256: string) {
  return {
    kind: target.kind,
    itemId: target.itemId ?? null,
    incidentId: target.incidentId ?? null,
    evidenceRequestId: target.evidenceRequestId ?? null,
    sha256,
  };
}

/** Resolves and authorizes a photo target; shared by the pre-check and the commit. */
function resolveTarget(ctx: Ctx, actor: Actor, target: PhotoTarget) {
  const { db } = ctx;
  if (target.kind === "baseline") {
    if (!target.itemId) throw invalid("missing_item", "A baseline photo needs an item.");
    const item = db.get(db.q.selectFrom("items").select(["id", "move_id"]).where("id", "=", target.itemId));
    if (!item) throw notFound("Item");
    requireMovePermission(ctx, actor, item.move_id, "inventory.write");
    return { moveId: item.move_id, itemId: item.id, incidentId: null, evidenceRequestId: null };
  }
  if (!target.incidentId) throw invalid("missing_incident", "An incident photo needs an incident.");
  const incident = db.get(
    db.q.selectFrom("damage_incidents").select(["id", "move_id", "status"]).where("id", "=", target.incidentId),
  );
  if (!incident) throw notFound("Incident");
  requireMovePermission(ctx, actor, incident.move_id, "inventory.write");
  if (incident.status === "resolved") {
    throw new DomainError("conflict", "incident_resolved", "This incident is resolved and no longer takes evidence.");
  }
  if (target.evidenceRequestId) {
    const request = db.get(
      db.q
        .selectFrom("evidence_requests")
        .select(["id", "incident_id", "status"])
        .where("id", "=", target.evidenceRequestId),
    );
    if (!request || request.incident_id !== incident.id) throw notFound("Evidence request");
    if (request.status !== "open") {
      throw new DomainError("conflict", "request_closed", "This evidence request is already closed.");
    }
  }
  return {
    moveId: incident.move_id,
    itemId: null,
    incidentId: incident.id,
    evidenceRequestId: target.evidenceRequestId ?? null,
  };
}

/**
 * Before the file is written: authorizes the target and returns the earlier
 * outcome if this upload was already committed under the same action ID.
 */
export function precheckPhoto(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  target: PhotoTarget,
  sha256: string,
): PhotoView | null {
  const replay = peekAction<PhotoView>(ctx, actor, {
    actionId,
    operation: "photo.attach",
    fingerprint: photoFingerprint(target, sha256),
  });
  if (replay) return replay;
  resolveTarget(ctx, actor, target);
  return null;
}

/**
 * Commits metadata for a file already moved to its final location.
 * Only committed photos are ever shown. If this throws, or returns replayed,
 * the caller deletes the file it wrote.
 */
export function attachPhoto(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  target: PhotoTarget,
  file: StoredFile,
): { photo: PhotoView; replayed: boolean } {
  const result = runAction(
    ctx,
    actor,
    { actionId, operation: "photo.attach", fingerprint: photoFingerprint(target, file.sha256) },
    () => {
      const resolved = resolveTarget(ctx, actor, target);
      const now = ctx.now();
      ctx.db.run(
        ctx.db.q.insertInto("photos").values({
          id: file.photoId,
          move_id: resolved.moveId,
          kind: target.kind,
          item_id: resolved.itemId,
          incident_id: resolved.incidentId,
          evidence_request_id: resolved.evidenceRequestId,
          storage_key: file.storageKey,
          media_type: file.mediaType,
          size_bytes: file.sizeBytes,
          sha256: file.sha256,
          uploaded_by: actor.id,
          created_at: now,
        }),
      );
      if (resolved.evidenceRequestId) {
        ctx.db.run(
          ctx.db.q
            .updateTable("evidence_requests")
            .set((eb) => ({
              status: "fulfilled",
              closed_by: actor.id,
              closed_at: now,
              revision: eb("revision", "+", 1),
            }))
            .where("id", "=", resolved.evidenceRequestId),
        );
      }
      recordAudit(ctx, {
        moveId: resolved.moveId,
        actorId: actor.id,
        action: target.kind === "baseline" ? "photo.baseline_added" : "photo.incident_added",
        recordType: target.kind === "baseline" ? "item" : "incident",
        recordId: (resolved.itemId ?? resolved.incidentId)!,
        after: { photoId: file.photoId, evidenceRequestId: resolved.evidenceRequestId },
        actionId,
      });
      const view: PhotoView = {
        id: file.photoId,
        kind: target.kind,
        itemId: resolved.itemId,
        incidentId: resolved.incidentId,
        evidenceRequestId: resolved.evidenceRequestId,
        mediaType: file.mediaType,
        sizeBytes: file.sizeBytes,
        uploadedByName: actor.displayName,
        createdAt: now,
        available: true,
      };
      return view;
    },
  );
  return { photo: result.outcome, replayed: result.replayed };
}

/** Storage keys of committed photos; used to find orphaned files. */
export function committedStorageKeys(ctx: Ctx): Set<string> {
  return new Set(ctx.db.all(ctx.db.q.selectFrom("photos").select("storage_key")).map((r) => r.storage_key));
}

/** Sniffs the real content type from the first bytes; file names and declared types are not trusted. */
export function sniffImageType(bytes: Uint8Array): PhotoMediaType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}
