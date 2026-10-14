import type { AssessmentVerdict } from "@/db/schema";
import { recordAudit } from "./actions";
import { Assessment, MAX_ASSESSED_PHOTOS, type AiProvider, type InterpretResult } from "./ai";
import {
  estimateMicroSgd,
  markUncertain,
  pricingFor,
  recordProviderFailure,
  recordProviderSuccess,
  release,
  reserve,
  settle,
  usageSummary,
} from "./budget";
import { DomainError, invalid, notFound, type Actor, type Ctx } from "./core";
import { requireMovePermission } from "./moves";

export const ASSESS_TIMEOUT_MS = 30_000;
/** Checks per incident, so repeated retakes cannot drain the allowance. */
export const MAX_ASSESSMENTS_PER_INCIDENT = 5;
const MAX_PENDING_GLOBAL = 2;

export interface AssessmentView {
  id: string;
  incidentId: string;
  status: "pending" | "completed" | "failed";
  verdict: AssessmentVerdict | null;
  summary: string | null;
  observations: string[];
  severity: "minor" | "moderate" | "severe" | null;
  matchesReport: "yes" | "no" | "unclear" | null;
  limitations: string | null;
  retakeRequest: string | null;
  photoCount: number;
  usedBaseline: boolean;
  model: string;
  requestedByName: string;
  /** Why a check failed, in words for the mover. */
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

const ERROR_MESSAGES: Record<string, string> = {
  provider_unavailable: "The AI check is unavailable right now. A reviewer will look at the photo.",
  invalid_result: "The AI check gave an unusable answer. A reviewer will look at the photo.",
  photo_unreadable: "The photo could not be read for the AI check. A reviewer will look at it.",
  interrupted: "The AI check was interrupted. A reviewer will look at the photo.",
};

function assessmentQuery(ctx: Ctx) {
  return ctx.db.q
    .selectFrom("ai_assessments")
    .innerJoin("users", "users.id", "ai_assessments.requested_by")
    .selectAll("ai_assessments")
    .select("users.display_name as requester_name");
}

type AssessmentRow = NonNullable<ReturnType<typeof getAssessmentRow>>;

function getAssessmentRow(ctx: Ctx, id: string) {
  return ctx.db.get(assessmentQuery(ctx).where("ai_assessments.id", "=", id));
}

function toView(row: AssessmentRow): AssessmentView {
  const result = row.result_json ? (JSON.parse(row.result_json) as Assessment) : null;
  return {
    id: row.id,
    incidentId: row.incident_id,
    status: row.status,
    verdict: row.verdict,
    summary: result?.summary ?? null,
    observations: result?.observations ?? [],
    severity: result?.severity ?? null,
    matchesReport: result?.matches_report ?? null,
    limitations: result?.limitations ?? null,
    retakeRequest: result?.retake_request ?? null,
    photoCount: (JSON.parse(row.photo_ids_json) as string[]).length,
    usedBaseline: row.baseline_photo_id !== null,
    model: row.model,
    requestedByName: row.requester_name,
    errorMessage: row.error_reason ? (ERROR_MESSAGES[row.error_reason] ?? ERROR_MESSAGES.provider_unavailable) : null,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/** Newest first. Read access is checked by the caller (getIncident). */
export function listAssessments(ctx: Ctx, incidentId: string): AssessmentView[] {
  return ctx.db
    .all(assessmentQuery(ctx).where("ai_assessments.incident_id", "=", incidentId).orderBy("ai_assessments.created_at", "desc"))
    .map(toView);
}

interface Prepared {
  usageId: string;
  photos: { storage_key: string; media_type: string }[];
  baseline: { storage_key: string; media_type: string } | null;
  report: string;
  itemDescription: string | null;
}

/**
 * Asks the AI whether the incident's newest photos show damage.
 * 1. In one transaction: replay check, limits, budget reservation, a 'pending' row.
 * 2. Outside any transaction: read the photos and call the provider, with a timeout.
 * 3. In one transaction: settle the cost and store the validated result.
 * The result is an observation only: it never opens, releases or changes holds or decisions.
 */
export async function assessIncident(
  ctx: Ctx,
  provider: AiProvider,
  actor: Actor,
  actionId: string,
  input: { incidentId: string },
  options: { timeoutMs?: number } = {},
): Promise<AssessmentView> {
  const timeoutMs = options.timeoutMs ?? ASSESS_TIMEOUT_MS;
  const prepared = prepare(ctx, provider, actor, actionId, input.incidentId, timeoutMs);
  if ("replay" in prepared) return prepared.replay;

  let images: { photos: { bytes: Uint8Array; mimeType: string }[]; baseline: { bytes: Uint8Array; mimeType: string } | null };
  try {
    const read = async (p: { storage_key: string; media_type: string }) => ({
      bytes: await ctx.photos.read(p.storage_key),
      mimeType: p.media_type,
    });
    images = {
      photos: await Promise.all(prepared.photos.map(read)),
      baseline: prepared.baseline ? await read(prepared.baseline) : null,
    };
  } catch {
    return finish(ctx, provider, actionId, prepared, { kind: "rejected", reason: "photo_unreadable" }, "photo_unreadable");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let result: InterpretResult;
  try {
    result = await provider.assessDamage({
      ...images,
      itemDescription: prepared.itemDescription,
      report: prepared.report,
      signal: controller.signal,
    });
  } catch (error) {
    result = { kind: "unknown", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
  return finish(ctx, provider, actionId, prepared, result);
}

function prepare(
  ctx: Ctx,
  provider: AiProvider,
  actor: Actor,
  actionId: string,
  incidentId: string,
  timeoutMs: number,
): Prepared | { replay: AssessmentView } {
  const { db } = ctx;
  return db.transaction(() => {
    expireStalePending(ctx, timeoutMs);
    const existing = getAssessmentRow(ctx, actionId);
    if (existing) {
      if (existing.requested_by !== actor.id || existing.incident_id !== incidentId) {
        throw new DomainError("conflict", "action_id_reused", "This action ID was already used for a different request.");
      }
      // Never re-dispatch: a pending check may already have reached the provider.
      if (existing.status === "pending") {
        throw new DomainError("conflict", "action_in_progress", "This photo is still being checked.");
      }
      return { replay: toView(existing) };
    }

    const incident = db.get(
      db.q
        .selectFrom("damage_incidents")
        .leftJoin("items", "items.id", "damage_incidents.item_id")
        .select([
          "damage_incidents.id",
          "damage_incidents.move_id",
          "damage_incidents.item_id",
          "damage_incidents.report",
          "damage_incidents.status",
          "items.description as item_description",
        ])
        .where("damage_incidents.id", "=", incidentId),
    );
    if (!incident) throw notFound("Incident");
    requireMovePermission(ctx, actor, incident.move_id, "inventory.write");
    if (incident.status === "resolved") {
      throw new DomainError("conflict", "incident_resolved", "This incident is resolved.");
    }

    const counts = db.get(
      db.q
        .selectFrom("ai_assessments")
        .select((eb) => [
          eb.fn.countAll<number>().as("all_pending"),
          eb.fn.sum<number>(eb.case().when("incident_id", "=", incidentId).then(1).else(0).end()).as("mine"),
        ])
        .where("status", "=", "pending"),
    );
    if (Number(counts?.mine ?? 0) > 0) {
      throw new DomainError("unavailable", "ai_busy", "Already checking this incident's photos.");
    }
    if (Number(counts?.all_pending ?? 0) >= MAX_PENDING_GLOBAL) {
      throw new DomainError("unavailable", "ai_busy", "The assistant is busy. A reviewer will see the photo either way.");
    }
    const done = db.get(
      db.q
        .selectFrom("ai_assessments")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("incident_id", "=", incidentId),
    );
    if (Number(done?.n ?? 0) >= MAX_ASSESSMENTS_PER_INCIDENT) {
      throw new DomainError(
        "unavailable",
        "assessment_limit",
        `These photos have been checked ${MAX_ASSESSMENTS_PER_INCIDENT} times. A reviewer will look at them.`,
      );
    }

    const photos = db
      .all(
        db.q
          .selectFrom("photos")
          .select(["id", "storage_key", "media_type"])
          .where("incident_id", "=", incidentId)
          .orderBy("created_at", "desc")
          .limit(MAX_ASSESSED_PHOTOS),
      )
      .filter((p) => ctx.photos.exists(p.storage_key))
      .reverse();
    if (photos.length === 0) throw invalid("no_photo", "Add a photo of the damage first.");
    const baseline = incident.item_id
      ? (db
          .all(
            db.q
              .selectFrom("photos")
              .select(["id", "storage_key", "media_type"])
              .where("item_id", "=", incident.item_id)
              .where("kind", "=", "baseline")
              .orderBy("created_at", "desc"),
          )
          .find((p) => ctx.photos.exists(p.storage_key)) ?? null)
      : null;

    // The row comes first (usage references it); a failed reservation rolls both back.
    db.run(
      db.q.insertInto("ai_assessments").values({
        id: actionId,
        incident_id: incidentId,
        move_id: incident.move_id,
        requested_by: actor.id,
        status: "pending",
        photo_ids_json: JSON.stringify(photos.map((p) => p.id)),
        baseline_photo_id: baseline?.id ?? null,
        verdict: null,
        result_json: null,
        model: provider.model,
        error_reason: null,
        created_at: ctx.now(),
        completed_at: null,
      }),
    );
    const pricing = pricingFor(provider.model);
    const usageId = reserve(ctx, {
      requestId: actionId,
      operation: "assess_damage",
      model: provider.model,
      pricing,
      estimateMicroSgd: estimateMicroSgd(pricing, usageSummary(ctx).usdToSgd, {
        audioSeconds: 0,
        images: photos.length + (baseline ? 1 : 0),
        promptChars: provider.assessOverheadChars + incident.report.length + (incident.item_description?.length ?? 0),
      }),
    });
    return {
      usageId,
      photos,
      baseline,
      report: incident.report,
      itemDescription: incident.item_description,
    };
  });
}

function finish(
  ctx: Ctx,
  provider: AiProvider,
  assessmentId: string,
  prepared: Prepared,
  result: InterpretResult,
  failureReason?: string,
): AssessmentView {
  return ctx.db.transaction(() => {
    let status: "completed" | "failed" = "failed";
    let errorReason: string | null = failureReason ?? "provider_unavailable";
    let verdict: AssessmentVerdict | null = null;
    let resultJson: string | null = null;

    if (result.kind === "unknown") {
      markUncertain(ctx, prepared.usageId);
      recordProviderFailure(ctx);
    } else if (result.kind === "rejected") {
      release(ctx, prepared.usageId);
      // An unreadable local file says nothing about the provider's health.
      if (!failureReason) recordProviderFailure(ctx);
    } else {
      settle(ctx, prepared.usageId, provider.model, result.usage);
      recordProviderSuccess(ctx);
      const parsed = Assessment.safeParse(result.raw);
      if (!parsed.success) {
        errorReason = "invalid_result";
      } else {
        status = "completed";
        errorReason = null;
        verdict = parsed.data.verdict;
        resultJson = JSON.stringify(parsed.data);
      }
    }

    ctx.db.run(
      ctx.db.q
        .updateTable("ai_assessments")
        .set({ status, verdict, result_json: resultJson, error_reason: errorReason, completed_at: ctx.now() })
        .where("id", "=", assessmentId),
    );
    const row = getAssessmentRow(ctx, assessmentId)!;
    recordAudit(ctx, {
      moveId: row.move_id,
      actorId: row.requested_by,
      action: status === "completed" ? "incident.ai_assessed" : "incident.ai_assessment_failed",
      recordType: "incident",
      recordId: row.incident_id,
      after: status === "completed" ? { verdict, model: provider.model } : { reason: errorReason },
      actionId: assessmentId,
    });
    return toView(row);
  });
}

/** Checks left pending by a crash or restart become visible failures; their cost stays charged. */
function expireStalePending(ctx: Ctx, timeoutMs: number) {
  const cutoff = new Date(Date.parse(ctx.now()) - timeoutMs * 2).toISOString();
  const stale = ctx.db.all(
    ctx.db.q.selectFrom("ai_assessments").select("id").where("status", "=", "pending").where("created_at", "<", cutoff),
  );
  for (const { id } of stale) {
    ctx.db.run(
      ctx.db.q
        .updateTable("ai_assessments")
        .set({ status: "failed", error_reason: "interrupted", completed_at: ctx.now() })
        .where("id", "=", id),
    );
    ctx.db.run(
      ctx.db.q
        .updateTable("ai_usage")
        .set({ status: "uncertain", settled_at: ctx.now() })
        .where("request_id", "=", id)
        .where("status", "=", "reserved"),
    );
  }
}
