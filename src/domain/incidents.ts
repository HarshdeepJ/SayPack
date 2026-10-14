import type { AssessmentVerdict, DecisionAction, EvidenceRequestStatus, IncidentStatus, Stage } from "@/db/schema";
import { recordAudit, runAction } from "./actions";
import { listAssessments, type AssessmentView } from "./assessment";
import { DomainError, invalid, notFound, staleRevision, type Actor, type Ctx } from "./core";
import { listIncidentPhotos, listItemBaselinePhotos, type PhotoView } from "./evidence";
import { cleanOptional, cleanText, getItemRow, toItemView, type ItemView } from "./inventory";
import { requireMovePermission } from "./moves";

const MAX_REPORT = 1000;
const MAX_REASON = 500;

// ---------- Views ----------

export interface IncidentSummary {
  id: string;
  moveId: string;
  itemId: string | null;
  itemDescription: string | null;
  boxLabel: string | null;
  stage: Stage;
  report: string;
  status: IncidentStatus;
  latestDecision: DecisionAction | null;
  repackedAt: string | null;
  reportedByName: string;
  photoCount: number;
  openEvidenceRequests: number;
  /** This incident's item hold is still active. */
  holdActive: boolean;
  /** Latest completed AI photo check, if any. An observation, never a decision. */
  aiVerdict: AssessmentVerdict | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface EvidenceRequestView {
  id: string;
  incidentId: string;
  requestText: string;
  status: EvidenceRequestStatus;
  requestedByName: string;
  revision: number;
  createdAt: string;
  closedAt: string | null;
}

export interface DecisionView {
  id: string;
  action: DecisionAction;
  reason: string | null;
  reviewerName: string;
  createdAt: string;
}

export interface HoldView {
  id: string;
  moveId: string;
  scope: "item" | "move";
  itemId: string | null;
  itemDescription: string | null;
  incidentId: string | null;
  reason: string;
  createdByName: string;
  createdAt: string;
  releasedAt: string | null;
  releasedByName: string | null;
  releaseReason: string | null;
  revision: number;
}

export interface IncidentDetail {
  incident: IncidentSummary;
  item: ItemView | null;
  baselinePhotos: PhotoView[];
  incidentPhotos: PhotoView[];
  evidenceRequests: EvidenceRequestView[];
  decisions: DecisionView[];
  holds: HoldView[];
  assessments: AssessmentView[];
  canReview: boolean;
  canWrite: boolean;
}

function incidentQuery(ctx: Ctx) {
  return ctx.db.q
    .selectFrom("damage_incidents")
    .innerJoin("users", "users.id", "damage_incidents.reported_by")
    .leftJoin("items", "items.id", "damage_incidents.item_id")
    .leftJoin("boxes", "boxes.id", "items.box_id")
    .select((eb) => [
      "damage_incidents.id",
      "damage_incidents.move_id",
      "damage_incidents.item_id",
      "damage_incidents.stage",
      "damage_incidents.report",
      "damage_incidents.status",
      "damage_incidents.latest_decision",
      "damage_incidents.repacked_at",
      "damage_incidents.revision",
      "damage_incidents.created_at",
      "damage_incidents.updated_at",
      "damage_incidents.resolved_at",
      "users.display_name as reporter_name",
      "items.description as item_description",
      "boxes.label as box_label",
      eb
        .selectFrom("photos")
        .select(eb.fn.countAll<number>().as("n"))
        .whereRef("photos.incident_id", "=", "damage_incidents.id")
        .as("photo_count"),
      eb
        .selectFrom("evidence_requests")
        .select(eb.fn.countAll<number>().as("n"))
        .whereRef("evidence_requests.incident_id", "=", "damage_incidents.id")
        .where("evidence_requests.status", "=", "open")
        .as("open_requests"),
      eb
        .selectFrom("holds")
        .select(eb.fn.countAll<number>().as("n"))
        .whereRef("holds.incident_id", "=", "damage_incidents.id")
        .where("holds.item_id", "is not", null)
        .where("holds.released_at", "is", null)
        .as("active_holds"),
      eb
        .selectFrom("ai_assessments")
        .select("ai_assessments.verdict")
        .whereRef("ai_assessments.incident_id", "=", "damage_incidents.id")
        .where("ai_assessments.status", "=", "completed")
        .orderBy("ai_assessments.created_at", "desc")
        .limit(1)
        .as("ai_verdict"),
    ]);
}

type IncidentRow = NonNullable<ReturnType<typeof getIncidentRow>>;

function getIncidentRow(ctx: Ctx, incidentId: string) {
  return ctx.db.get(incidentQuery(ctx).where("damage_incidents.id", "=", incidentId));
}

function toSummary(row: IncidentRow): IncidentSummary {
  return {
    id: row.id,
    moveId: row.move_id,
    itemId: row.item_id,
    itemDescription: row.item_description,
    boxLabel: row.box_label,
    stage: row.stage,
    report: row.report,
    status: row.status,
    latestDecision: row.latest_decision,
    repackedAt: row.repacked_at,
    reportedByName: row.reporter_name,
    photoCount: Number(row.photo_count ?? 0),
    openEvidenceRequests: Number(row.open_requests ?? 0),
    holdActive: Number(row.active_holds ?? 0) > 0,
    aiVerdict: row.ai_verdict ?? null,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function holdQuery(ctx: Ctx) {
  return ctx.db.q
    .selectFrom("holds")
    .innerJoin("users as creator", "creator.id", "holds.created_by")
    .leftJoin("users as releaser", "releaser.id", "holds.released_by")
    .leftJoin("items", "items.id", "holds.item_id")
    .select([
      "holds.id",
      "holds.move_id",
      "holds.item_id",
      "holds.incident_id",
      "holds.reason",
      "holds.created_at",
      "holds.released_at",
      "holds.release_reason",
      "holds.revision",
      "creator.display_name as creator_name",
      "releaser.display_name as releaser_name",
      "items.description as item_description",
    ]);
}

function toHoldView(row: HoldRow): HoldView {
  return {
    id: row.id,
    moveId: row.move_id,
    scope: row.item_id ? "item" : "move",
    itemId: row.item_id,
    itemDescription: row.item_description,
    incidentId: row.incident_id,
    reason: row.reason,
    createdByName: row.creator_name,
    createdAt: row.created_at,
    releasedAt: row.released_at,
    releasedByName: row.releaser_name,
    releaseReason: row.release_reason,
    revision: row.revision,
  };
}

interface HoldRow {
  id: string;
  move_id: string;
  item_id: string | null;
  incident_id: string | null;
  reason: string;
  created_at: string;
  released_at: string | null;
  release_reason: string | null;
  revision: number;
  creator_name: string;
  releaser_name: string | null;
  item_description: string | null;
}

/** Loads an incident for a mutation, checking permission and expected revision. */
function loadForChange(
  ctx: Ctx,
  actor: Actor,
  incidentId: string,
  expectedRevision: number,
  permission: "inventory.write" | "incident.review",
) {
  const row = getIncidentRow(ctx, incidentId);
  if (!row) throw notFound("Incident");
  requireMovePermission(ctx, actor, row.move_id, permission);
  if (row.revision !== expectedRevision) throw staleRevision(toSummary(row));
  return row;
}

function bumpIncident(ctx: Ctx, row: IncidentRow, changes: Record<string, unknown>) {
  ctx.db.run(
    ctx.db.q
      .updateTable("damage_incidents")
      .set({ ...changes, revision: row.revision + 1, updated_at: ctx.now() })
      .where("id", "=", row.id),
  );
}

function createItemHold(ctx: Ctx, actor: Actor, incident: { id: string; move_id: string }, itemId: string, report: string) {
  const id = ctx.newId();
  ctx.db.run(
    ctx.db.q.insertInto("holds").values({
      id,
      move_id: incident.move_id,
      item_id: itemId,
      incident_id: incident.id,
      reason: `Damage reported: ${report}`,
      created_by: actor.id,
      created_at: ctx.now(),
      released_at: null,
      released_by: null,
      release_reason: null,
      revision: 1,
    }),
  );
  return id;
}

/** Releases only this incident's item holds; other incidents' and whole-move holds stay active. */
function releaseIncidentItemHolds(ctx: Ctx, actor: Actor, incidentId: string, reason: string) {
  ctx.db.run(
    ctx.db.q
      .updateTable("holds")
      .set((eb) => ({
        released_at: ctx.now(),
        released_by: actor.id,
        release_reason: reason,
        revision: eb("revision", "+", 1),
      }))
      .where("incident_id", "=", incidentId)
      .where("item_id", "is not", null)
      .where("released_at", "is", null),
  );
}

// ---------- Reads ----------

export function listIncidents(
  ctx: Ctx,
  actor: Actor,
  input: { moveId: string; filter?: "unresolved" | "resolved" | "all" },
): IncidentSummary[] {
  requireMovePermission(ctx, actor, input.moveId, "inventory.read");
  let query = incidentQuery(ctx).where("damage_incidents.move_id", "=", input.moveId);
  if (input.filter === "resolved") query = query.where("damage_incidents.status", "=", "resolved");
  else if (input.filter !== "all") query = query.where("damage_incidents.status", "!=", "resolved");
  // Oldest unresolved first, so nothing waits unseen at the bottom of the queue.
  const order = input.filter === "resolved" ? "desc" : "asc";
  return ctx.db.all(query.orderBy("damage_incidents.created_at", order).limit(200)).map(toSummary);
}

export function listItemIncidents(ctx: Ctx, itemId: string): IncidentSummary[] {
  return ctx.db
    .all(incidentQuery(ctx).where("damage_incidents.item_id", "=", itemId).orderBy("damage_incidents.created_at", "desc"))
    .map(toSummary);
}

export function listHolds(
  ctx: Ctx,
  actor: Actor,
  input: { moveId: string; activeOnly?: boolean; scope?: "item" | "move" },
): HoldView[] {
  requireMovePermission(ctx, actor, input.moveId, "inventory.read");
  return activeHolds(ctx, input);
}

export function activeHolds(
  ctx: Ctx,
  input: { moveId: string; activeOnly?: boolean; scope?: "item" | "move"; itemId?: string },
): HoldView[] {
  let query = holdQuery(ctx).where("holds.move_id", "=", input.moveId);
  if (input.activeOnly !== false) query = query.where("holds.released_at", "is", null);
  if (input.scope === "move") query = query.where("holds.item_id", "is", null);
  if (input.scope === "item") query = query.where("holds.item_id", "is not", null);
  if (input.itemId) query = query.where("holds.item_id", "=", input.itemId);
  return ctx.db.all(query.orderBy("holds.created_at", "desc")).map((r) => toHoldView(r as HoldRow));
}

export function getIncident(ctx: Ctx, actor: Actor, incidentId: string): IncidentDetail {
  const row = getIncidentRow(ctx, incidentId);
  if (!row) throw notFound("Incident");
  const roles = requireMovePermission(ctx, actor, row.move_id, "inventory.read");
  const { db } = ctx;
  const itemRow = row.item_id ? getItemRow(ctx, row.item_id) : undefined;

  const evidenceRequests = db
    .all(
      db.q
        .selectFrom("evidence_requests")
        .innerJoin("users", "users.id", "evidence_requests.requested_by")
        .select([
          "evidence_requests.id",
          "evidence_requests.incident_id",
          "evidence_requests.request_text",
          "evidence_requests.status",
          "evidence_requests.revision",
          "evidence_requests.created_at",
          "evidence_requests.closed_at",
          "users.display_name",
        ])
        .where("evidence_requests.incident_id", "=", incidentId)
        .orderBy("evidence_requests.created_at"),
    )
    .map((r) => ({
      id: r.id,
      incidentId: r.incident_id,
      requestText: r.request_text,
      status: r.status,
      requestedByName: r.display_name,
      revision: r.revision,
      createdAt: r.created_at,
      closedAt: r.closed_at,
    }));

  const decisions = db
    .all(
      db.q
        .selectFrom("decisions")
        .innerJoin("users", "users.id", "decisions.reviewer_id")
        .select(["decisions.id", "decisions.action", "decisions.reason", "decisions.created_at", "users.display_name"])
        .where("decisions.incident_id", "=", incidentId)
        .orderBy("decisions.created_at"),
    )
    .map((d) => ({
      id: d.id,
      action: d.action,
      reason: d.reason,
      reviewerName: d.display_name,
      createdAt: d.created_at,
    }));

  const holds = db
    .all(holdQuery(ctx).where("holds.incident_id", "=", incidentId).orderBy("holds.created_at"))
    .map((r) => toHoldView(r as HoldRow));

  return {
    incident: toSummary(row),
    item: itemRow ? toItemView(itemRow) : null,
    baselinePhotos: row.item_id ? listItemBaselinePhotos(ctx, row.item_id) : [],
    incidentPhotos: listIncidentPhotos(ctx, incidentId),
    evidenceRequests,
    decisions,
    holds,
    assessments: listAssessments(ctx, incidentId),
    canReview: roles.includes("reviewer"),
    canWrite: roles.some((r) => r === "mover" || r === "reviewer"),
  };
}

// ---------- Reporting ----------

/**
 * Saves a damage report immediately, before any photo or assessment.
 * With a known item, its incident hold is created in the same transaction.
 */
export function reportDamage(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  input: { moveId: string; itemId?: string | null; report: string; stage?: Stage },
): IncidentSummary {
  const fields = {
    moveId: input.moveId,
    itemId: input.itemId || null,
    report: cleanText(input.report, MAX_REPORT, "bad_report", "what is damaged"),
    stage: input.stage ?? "packing",
  };
  return runAction(ctx, actor, { actionId, operation: "incident.report", fingerprint: fields }, () => {
    requireMovePermission(ctx, actor, fields.moveId, "inventory.write");
    if (fields.itemId) {
      const item = ctx.db.get(ctx.db.q.selectFrom("items").select("move_id").where("id", "=", fields.itemId));
      if (!item || item.move_id !== fields.moveId) throw notFound("Item");
    }
    const id = ctx.newId();
    const now = ctx.now();
    ctx.db.run(
      ctx.db.q.insertInto("damage_incidents").values({
        id,
        move_id: fields.moveId,
        item_id: fields.itemId,
        stage: fields.stage,
        report: fields.report,
        status: "open",
        latest_decision: null,
        repacked_at: null,
        repacked_by: null,
        reported_by: actor.id,
        revision: 1,
        created_at: now,
        updated_at: now,
        resolved_at: null,
      }),
    );
    if (fields.itemId) createItemHold(ctx, actor, { id, move_id: fields.moveId }, fields.itemId, fields.report);
    recordAudit(ctx, {
      moveId: fields.moveId,
      actorId: actor.id,
      action: "incident.reported",
      recordType: "incident",
      recordId: id,
      after: { itemId: fields.itemId, report: fields.report, stage: fields.stage },
      actionId,
    });
    if (fields.itemId) {
      recordAudit(ctx, {
        moveId: fields.moveId,
        actorId: actor.id,
        action: "item.damage_reported",
        recordType: "item",
        recordId: fields.itemId,
        after: { incidentId: id, report: fields.report },
        actionId,
      });
    }
    return toSummary(getIncidentRow(ctx, id)!);
  }).outcome;
}

/** Links an unidentified incident to its item and creates the item hold atomically. */
export function identifyIncidentItem(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  input: { incidentId: string; expectedRevision: number; itemId: string },
): IncidentSummary {
  return runAction(ctx, actor, { actionId, operation: "incident.identify_item", fingerprint: input }, () => {
    const row = loadForChange(ctx, actor, input.incidentId, input.expectedRevision, "inventory.write");
    if (row.item_id) throw new DomainError("conflict", "item_already_identified", "This incident already has an item.");
    if (row.status === "resolved") throw new DomainError("conflict", "incident_resolved", "This incident is resolved.");
    const item = ctx.db.get(ctx.db.q.selectFrom("items").select(["id", "move_id"]).where("id", "=", input.itemId));
    if (!item || item.move_id !== row.move_id) throw notFound("Item");
    bumpIncident(ctx, row, { item_id: item.id });
    createItemHold(ctx, actor, row, item.id, row.report);
    recordAudit(ctx, {
      moveId: row.move_id,
      actorId: actor.id,
      action: "incident.item_identified",
      recordType: "incident",
      recordId: row.id,
      before: { itemId: null },
      after: { itemId: item.id },
      actionId,
    });
    recordAudit(ctx, {
      moveId: row.move_id,
      actorId: actor.id,
      action: "item.damage_reported",
      recordType: "item",
      recordId: item.id,
      after: { incidentId: row.id, report: row.report },
      actionId,
    });
    return toSummary(getIncidentRow(ctx, row.id)!);
  }).outcome;
}

// ---------- Evidence requests ----------

export function requestEvidence(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  input: { incidentId: string; requestText: string },
): EvidenceRequestView {
  const requestText = cleanText(input.requestText, MAX_REASON, "bad_request", "what evidence is needed");
  return runAction(
    ctx,
    actor,
    { actionId, operation: "evidence.request", fingerprint: { incidentId: input.incidentId, requestText } },
    () => {
      const row = getIncidentRow(ctx, input.incidentId);
      if (!row) throw notFound("Incident");
      requireMovePermission(ctx, actor, row.move_id, "incident.review");
      if (row.status === "resolved") throw new DomainError("conflict", "incident_resolved", "This incident is resolved.");
      const id = ctx.newId();
      const now = ctx.now();
      ctx.db.run(
        ctx.db.q.insertInto("evidence_requests").values({
          id,
          move_id: row.move_id,
          incident_id: row.id,
          request_text: requestText,
          status: "open",
          requested_by: actor.id,
          closed_by: null,
          revision: 1,
          created_at: now,
          closed_at: null,
        }),
      );
      recordAudit(ctx, {
        moveId: row.move_id,
        actorId: actor.id,
        action: "evidence.requested",
        recordType: "incident",
        recordId: row.id,
        after: { requestId: id, requestText },
        actionId,
      });
      return {
        id,
        incidentId: row.id,
        requestText,
        status: "open" as const,
        requestedByName: actor.displayName,
        revision: 1,
        createdAt: now,
        closedAt: null,
      };
    },
  ).outcome;
}

export function cancelEvidenceRequest(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  input: { requestId: string; expectedRevision: number },
) {
  return runAction(ctx, actor, { actionId, operation: "evidence.cancel", fingerprint: input }, () => {
    const { db } = ctx;
    const request = db.get(db.q.selectFrom("evidence_requests").selectAll().where("id", "=", input.requestId));
    if (!request) throw notFound("Evidence request");
    requireMovePermission(ctx, actor, request.move_id, "incident.review");
    if (request.revision !== input.expectedRevision) throw staleRevision({ status: request.status });
    if (request.status !== "open") throw new DomainError("conflict", "request_closed", "This request is already closed.");
    db.run(
      db.q
        .updateTable("evidence_requests")
        .set({ status: "cancelled", closed_by: actor.id, closed_at: ctx.now(), revision: request.revision + 1 })
        .where("id", "=", request.id),
    );
    recordAudit(ctx, {
      moveId: request.move_id,
      actorId: actor.id,
      action: "evidence.cancelled",
      recordType: "incident",
      recordId: request.incident_id,
      after: { requestId: request.id },
      actionId,
    });
    return { id: request.id, status: "cancelled" as const };
  }).outcome;
}

// ---------- Decisions ----------

/**
 * Records a reviewer decision.
 * - continue: releases only this incident's item hold and resolves it.
 * - repack: keeps the hold until repacking is recorded and a reviewer releases it.
 * - escalate: keeps the hold pending a later decision.
 * - close: only for an incident with no identified item; needs a reason.
 */
export function decideIncident(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  input: { incidentId: string; expectedRevision: number; action: DecisionAction; reason?: string | null },
): IncidentSummary {
  const reason = cleanOptional(input.reason, MAX_REASON, "the reason");
  const fingerprint = { ...input, reason };
  return runAction(ctx, actor, { actionId, operation: "incident.decide", fingerprint }, () => {
    const row = loadForChange(ctx, actor, input.incidentId, input.expectedRevision, "incident.review");
    if (row.status === "resolved") throw new DomainError("conflict", "incident_resolved", "This incident is already resolved.");
    const now = ctx.now();

    if (input.action === "close") {
      if (row.item_id) {
        throw invalid("item_identified", "This incident has an item. Choose continue, repack or escalate.");
      }
      if (!reason) throw invalid("reason_required", "Give a reason for closing an incident without an item.");
      bumpIncident(ctx, row, { status: "resolved", latest_decision: "close", resolved_at: now });
    } else {
      if (!row.item_id) {
        throw invalid("item_required", "Identify the affected item before deciding to continue or repack.");
      }
      if (input.action === "continue") {
        releaseIncidentItemHolds(ctx, actor, row.id, reason ?? "Reviewer decided packing may continue.");
        bumpIncident(ctx, row, { status: "resolved", latest_decision: "continue", resolved_at: now });
      } else if (input.action === "repack") {
        bumpIncident(ctx, row, { status: "open", latest_decision: "repack", repacked_at: null, repacked_by: null });
      } else {
        bumpIncident(ctx, row, { status: "escalated", latest_decision: "escalate" });
      }
    }

    ctx.db.run(
      ctx.db.q.insertInto("decisions").values({
        id: ctx.newId(),
        incident_id: row.id,
        reviewer_id: actor.id,
        action: input.action,
        reason,
        created_at: now,
      }),
    );
    recordAudit(ctx, {
      moveId: row.move_id,
      actorId: actor.id,
      action: `incident.decided_${input.action}`,
      recordType: "incident",
      recordId: row.id,
      before: { status: row.status, decision: row.latest_decision },
      after: { action: input.action, reason },
      actionId,
    });
    if (row.item_id) {
      recordAudit(ctx, {
        moveId: row.move_id,
        actorId: actor.id,
        action: "item.decision_recorded",
        recordType: "item",
        recordId: row.item_id,
        after: { incidentId: row.id, action: input.action, reason },
        actionId,
      });
    }
    return toSummary(getIncidentRow(ctx, row.id)!);
  }).outcome;
}

/** The mover records that a repack decision has been carried out. The hold stays until a reviewer releases it. */
export function recordRepack(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  input: { incidentId: string; expectedRevision: number },
): IncidentSummary {
  return runAction(ctx, actor, { actionId, operation: "incident.record_repack", fingerprint: input }, () => {
    const row = loadForChange(ctx, actor, input.incidentId, input.expectedRevision, "inventory.write");
    if (row.status !== "open" || row.latest_decision !== "repack") {
      throw new DomainError("conflict", "repack_not_requested", "No repack has been requested for this incident.");
    }
    if (row.repacked_at) throw new DomainError("conflict", "already_repacked", "Repacking is already recorded.");
    const now = ctx.now();
    bumpIncident(ctx, row, { repacked_at: now, repacked_by: actor.id });
    recordAudit(ctx, {
      moveId: row.move_id,
      actorId: actor.id,
      action: "incident.repacked",
      recordType: "incident",
      recordId: row.id,
      after: { repackedAt: now },
      actionId,
    });
    recordAudit(ctx, {
      moveId: row.move_id,
      actorId: actor.id,
      action: "item.repacked",
      recordType: "item",
      recordId: row.item_id!,
      after: { incidentId: row.id },
      actionId,
    });
    return toSummary(getIncidentRow(ctx, row.id)!);
  }).outcome;
}

/** After a recorded repack, the reviewer explicitly releases the incident's hold, which resolves it. */
export function releaseAfterRepack(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  input: { incidentId: string; expectedRevision: number; reason?: string | null },
): IncidentSummary {
  const reason = cleanOptional(input.reason, MAX_REASON, "the reason");
  return runAction(
    ctx,
    actor,
    { actionId, operation: "incident.release_after_repack", fingerprint: { ...input, reason } },
    () => {
      const row = loadForChange(ctx, actor, input.incidentId, input.expectedRevision, "incident.review");
      if (row.latest_decision !== "repack" || !row.repacked_at || row.status !== "open") {
        throw new DomainError("conflict", "repack_not_recorded", "Repacking has not been recorded for this incident.");
      }
      releaseIncidentItemHolds(ctx, actor, row.id, reason ?? "Repack verified by reviewer.");
      bumpIncident(ctx, row, { status: "resolved", resolved_at: ctx.now() });
      recordAudit(ctx, {
        moveId: row.move_id,
        actorId: actor.id,
        action: "incident.hold_released",
        recordType: "incident",
        recordId: row.id,
        after: { reason: reason ?? "Repack verified by reviewer." },
        actionId,
      });
      return toSummary(getIncidentRow(ctx, row.id)!);
    },
  ).outcome;
}

// ---------- Whole-move holds ----------

export function placeMoveHold(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  input: { moveId: string; reason: string; incidentId?: string | null },
): HoldView {
  const reason = cleanText(input.reason, MAX_REASON, "bad_reason", "a reason for the hold");
  const fields = { moveId: input.moveId, reason, incidentId: input.incidentId || null };
  return runAction(ctx, actor, { actionId, operation: "hold.place_move", fingerprint: fields }, () => {
    requireMovePermission(ctx, actor, fields.moveId, "incident.review");
    if (fields.incidentId) {
      const incident = ctx.db.get(
        ctx.db.q.selectFrom("damage_incidents").select("move_id").where("id", "=", fields.incidentId),
      );
      if (!incident || incident.move_id !== fields.moveId) throw notFound("Incident");
    }
    const id = ctx.newId();
    ctx.db.run(
      ctx.db.q.insertInto("holds").values({
        id,
        move_id: fields.moveId,
        item_id: null,
        incident_id: fields.incidentId,
        reason,
        created_by: actor.id,
        created_at: ctx.now(),
        released_at: null,
        released_by: null,
        release_reason: null,
        revision: 1,
      }),
    );
    recordAudit(ctx, {
      moveId: fields.moveId,
      actorId: actor.id,
      action: "hold.move_placed",
      recordType: "hold",
      recordId: id,
      after: { reason, incidentId: fields.incidentId },
      actionId,
    });
    return toHoldView(ctx.db.get(holdQuery(ctx).where("holds.id", "=", id)) as HoldRow);
  }).outcome;
}

/** Releases a whole-move hold. Item holds are released through their incident's decision. */
export function releaseMoveHold(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  input: { holdId: string; expectedRevision: number; reason: string },
): HoldView {
  const reason = cleanText(input.reason, MAX_REASON, "bad_reason", "a reason for releasing the hold");
  return runAction(
    ctx,
    actor,
    { actionId, operation: "hold.release_move", fingerprint: { ...input, reason } },
    () => {
      const hold = ctx.db.get(ctx.db.q.selectFrom("holds").selectAll().where("id", "=", input.holdId));
      if (!hold) throw notFound("Hold");
      requireMovePermission(ctx, actor, hold.move_id, "incident.review");
      if (hold.item_id) {
        throw invalid("item_hold", "Item holds are released by deciding their incident.");
      }
      if (hold.revision !== input.expectedRevision) throw staleRevision({ releasedAt: hold.released_at });
      if (hold.released_at) throw new DomainError("conflict", "hold_released", "This hold is already released.");
      ctx.db.run(
        ctx.db.q
          .updateTable("holds")
          .set({ released_at: ctx.now(), released_by: actor.id, release_reason: reason, revision: hold.revision + 1 })
          .where("id", "=", hold.id),
      );
      recordAudit(ctx, {
        moveId: hold.move_id,
        actorId: actor.id,
        action: "hold.move_released",
        recordType: "hold",
        recordId: hold.id,
        before: { reason: hold.reason },
        after: { releaseReason: reason },
        actionId,
      });
      return toHoldView(ctx.db.get(holdQuery(ctx).where("holds.id", "=", hold.id)) as HoldRow);
    },
  ).outcome;
}
