import { sql } from "kysely";
import type { ObservedCondition, VoiceOperation } from "@/db/schema";
import { runAction } from "./actions";
import { Interpretation, MAX_AUDIO_SECONDS, type AiProvider, type InterpretResult } from "./ai";
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
import { DomainError, forbidden, invalid, notFound, sha256, stableStringify, type Actor, type Ctx } from "./core";
import { recordObservation } from "./evidence";
import { reportDamage, type IncidentSummary } from "./incidents";
import { MAX_DESCRIPTION, getItemRow, toItemView, type ItemView } from "./inventory";
import { assignItemToBox, recordItem } from "./inventory-mutations";
import { requireMovePermission } from "./moves";

export const PROPOSAL_TTL_MS = 2 * 60 * 1000;
export const PROVIDER_TIMEOUT_MS = 30_000;
const MAX_TEXT_COMMAND = 300;
const MAX_PENDING_PER_SESSION = 1;
const MAX_PENDING_GLOBAL = 2;

// ---------- Types ----------

export interface VoiceContext {
  /** The mover's active box when they spoke; explicit box names are reconciled against it. */
  boxId: string | null;
}

export interface ProposalView {
  id: string;
  operation: VoiceOperation;
  readback: string;
  status: "pending" | "confirmed" | "cancelled" | "expired";
  expiresAt: string;
}

export type VoiceResult =
  | { kind: "proposal"; requestId: string; transcript: string; proposal: ProposalView }
  | { kind: "clarification"; requestId: string; transcript: string; question: string }
  | { kind: "failed"; requestId: string; transcript: string | null; reason: string; message: string };

export interface AiStatus {
  provider: string;
  model: string;
  available: boolean;
  reason: string | null;
  message: string | null;
  remainingSgd: number;
}

type ProposalArgs =
  | {
      operation: "record_item";
      boxId: string | null;
      description: string;
      category: string | null;
      fragile: boolean;
      valuable: boolean;
      condition: ObservedCondition | null;
      conditionNote: string | null;
    }
  | { operation: "assign_item_to_box"; itemId: string; expectedRevision: number; boxId: string }
  | { operation: "record_condition"; itemId: string; condition: ObservedCondition; note: string | null }
  | { operation: "report_damage"; itemId: string | null; report: string };

type Resolution =
  | { kind: "propose"; args: ProposalArgs; readback: string }
  | { kind: "clarify"; question: string }
  | { kind: "reject"; reason: string; message: string };

// ---------- Status ----------

export function aiStatus(ctx: Ctx, provider: AiProvider): AiStatus {
  const usage = usageSummary(ctx);
  const base = { provider: provider.name, model: provider.model, remainingSgd: usage.remainingSgd };
  if (usage.exhausted) {
    return { ...base, available: false, reason: "allowance_exhausted", message: "The AI allowance is used up." };
  }
  if (usage.breakerOpenUntil) {
    return { ...base, available: false, reason: "provider_unavailable", message: "Voice is paused after repeated AI errors." };
  }
  return { ...base, available: true, reason: null, message: null };
}

// ---------- Submitting a command ----------

export interface SubmitVoiceInput {
  moveId: string;
  actionId: string;
  context: VoiceContext;
  clarifiesRequestId?: string | null;
  audio?: { bytes: Uint8Array; mimeType: string; seconds: number };
  text?: string;
}

/**
 * Interprets one push-to-talk clip (or typed command) into a confirmable proposal.
 * 1. In one transaction: replay check, limits, budget reservation, a 'pending' request row.
 * 2. Outside any transaction: the provider call, with a timeout.
 * 3. In one transaction: settle the cost, validate and resolve the result, store the outcome.
 * Nothing in the inventory changes here; that needs confirmProposal.
 */
export async function submitVoice(
  ctx: Ctx,
  provider: AiProvider,
  actor: Actor,
  input: SubmitVoiceInput,
  options: { timeoutMs?: number } = {},
): Promise<VoiceResult> {
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const prepared = prepare(ctx, provider, actor, input, timeoutMs);
  if ("replay" in prepared) return prepared.replay;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let result: InterpretResult;
  try {
    result = await provider.interpret({
      audio: input.audio,
      text: input.text,
      context: prepared.contextText,
      signal: controller.signal,
    });
  } catch (error) {
    result = { kind: "unknown", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
  return finish(ctx, provider, actor, input, prepared, result);
}

interface Prepared {
  requestId: string;
  usageId: string;
  contextText: string;
}

function prepare(
  ctx: Ctx,
  provider: AiProvider,
  actor: Actor,
  input: SubmitVoiceInput,
  timeoutMs: number,
): Prepared | { replay: VoiceResult } {
  const text = input.text?.trim();
  if (!input.audio === !text) throw invalid("bad_input", "Send either a voice clip or a typed command.");
  if (text && text.length > MAX_TEXT_COMMAND) {
    throw invalid("too_long", `Typed commands must be ${MAX_TEXT_COMMAND} characters or fewer.`);
  }
  if (input.audio && !(input.audio.seconds > 0 && input.audio.seconds <= MAX_AUDIO_SECONDS + 1)) {
    throw invalid("bad_duration", `Voice clips must be ${MAX_AUDIO_SECONDS} seconds or shorter.`);
  }
  const inputHash = sha256(
    stableStringify({
      body: input.audio ? sha256(Buffer.from(input.audio.bytes).toString("base64")) : text,
      context: input.context,
      clarifies: input.clarifiesRequestId ?? null,
    }),
  );

  const { db } = ctx;
  return db.transaction(() => {
    expireStalePending(ctx, timeoutMs);
    const existing = db.get(db.q.selectFrom("voice_requests").selectAll().where("id", "=", input.actionId));
    if (existing) {
      if (existing.user_id !== actor.id || existing.move_id !== input.moveId || existing.input_hash !== inputHash) {
        throw new DomainError("conflict", "action_id_reused", "This action ID was already used for a different request.");
      }
      // Never re-dispatch: a pending request may already have reached the provider.
      if (existing.status === "pending") {
        throw new DomainError("conflict", "action_in_progress", "This command is still being processed.");
      }
      return { replay: JSON.parse(existing.result_json!) as VoiceResult };
    }

    requireMovePermission(ctx, actor, input.moveId, "inventory.write");
    const pending = db.get(
      db.q
        .selectFrom("voice_requests")
        .select((eb) => [
          eb.fn.countAll<number>().as("all"),
          eb.fn
            .sum<number>(
              eb.case().when(eb.and([eb("user_id", "=", actor.id), eb("move_id", "=", input.moveId)])).then(1).else(0).end(),
            )
            .as("mine"),
        ])
        .where("status", "=", "pending"),
    );
    if (Number(pending?.mine ?? 0) >= MAX_PENDING_PER_SESSION) {
      throw new DomainError("unavailable", "ai_busy", "Still working on your last command.");
    }
    if (Number(pending?.all ?? 0) >= MAX_PENDING_GLOBAL) {
      throw new DomainError("unavailable", "ai_busy", "The assistant is busy. Try again in a moment, or use manual entry.");
    }

    const activeBox = input.context.boxId ? boxInMoveOrNull(ctx, input.moveId, input.context.boxId) : null;
    if (input.context.boxId && !activeBox) throw notFound("Box");
    const clarifies = input.clarifiesRequestId
      ? db.get(db.q.selectFrom("voice_requests").selectAll().where("id", "=", input.clarifiesRequestId))
      : undefined;
    if (input.clarifiesRequestId) {
      if (!clarifies || clarifies.user_id !== actor.id || clarifies.move_id !== input.moveId) {
        throw notFound("Earlier question");
      }
    }
    const contextText = buildContext(ctx, input.moveId, activeBox, clarifies);

    // The request row comes first (usage references it); a failed reservation rolls both back.
    db.run(
      db.q.insertInto("voice_requests").values({
        id: input.actionId,
        move_id: input.moveId,
        user_id: actor.id,
        input_kind: input.audio ? "audio" : "text",
        input_hash: inputHash,
        audio_seconds: input.audio?.seconds ?? null,
        context_json: JSON.stringify(input.context),
        clarifies_request_id: input.clarifiesRequestId ?? null,
        status: "pending",
        transcript: null,
        result_json: null,
        error_reason: null,
        created_at: ctx.now(),
        completed_at: null,
      }),
    );
    const pricing = pricingFor(provider.model);
    const s = usageSummary(ctx);
    const usageId = reserve(ctx, {
      requestId: input.actionId,
      operation: "interpret",
      model: provider.model,
      pricing,
      estimateMicroSgd: estimateMicroSgd(pricing, s.usdToSgd, {
        audioSeconds: input.audio?.seconds ?? 0,
        promptChars: contextText.length + provider.overheadChars + (text?.length ?? 0),
      }),
    });
    return { requestId: input.actionId, usageId, contextText };
  });
}

function finish(
  ctx: Ctx,
  provider: AiProvider,
  actor: Actor,
  input: SubmitVoiceInput,
  prepared: Prepared,
  result: InterpretResult,
): VoiceResult {
  return ctx.db.transaction(() => {
    const failed = (reason: string, message: string, transcript: string | null = null): VoiceResult => ({
      kind: "failed",
      requestId: prepared.requestId,
      transcript,
      reason,
      message,
    });
    let outcome: VoiceResult;

    if (result.kind === "unknown") {
      markUncertain(ctx, prepared.usageId);
      recordProviderFailure(ctx);
      outcome = failed("provider_unavailable", "No answer from the assistant. Nothing was saved. Try again or use manual entry.");
    } else if (result.kind === "rejected") {
      release(ctx, prepared.usageId);
      recordProviderFailure(ctx);
      outcome = failed("provider_unavailable", "The assistant is unavailable right now. Nothing was saved. Use manual entry.");
    } else {
      settle(ctx, prepared.usageId, provider.model, result.usage);
      recordProviderSuccess(ctx);
      const parsed = Interpretation.safeParse(result.raw);
      if (!parsed.success) {
        outcome = failed("invalid_result", "The assistant's answer couldn't be used. Nothing was saved. Please try again.");
      } else {
        const interpretation = parsed.data;
        const transcript = interpretation.transcript.trim();
        const resolution = resolveInterpretation(ctx, input.moveId, input.context, interpretation);
        if (resolution.kind === "clarify") {
          outcome = { kind: "clarification", requestId: prepared.requestId, transcript, question: resolution.question };
        } else if (resolution.kind === "reject") {
          outcome = failed(resolution.reason, resolution.message, transcript);
        } else {
          const proposal = createProposal(ctx, actor, input, prepared.requestId, resolution);
          outcome = { kind: "proposal", requestId: prepared.requestId, transcript, proposal };
        }
      }
    }

    ctx.db.run(
      ctx.db.q
        .updateTable("voice_requests")
        .set({
          status: outcome.kind === "proposal" ? "proposed" : outcome.kind === "clarification" ? "clarification" : "failed",
          transcript: outcome.transcript,
          result_json: JSON.stringify(outcome),
          error_reason: outcome.kind === "failed" ? outcome.reason : null,
          completed_at: ctx.now(),
        })
        .where("id", "=", prepared.requestId),
    );
    return outcome;
  });
}

/** Requests left pending by a crash or restart become visible failures; their cost stays charged. */
function expireStalePending(ctx: Ctx, timeoutMs: number) {
  const cutoff = new Date(Date.parse(ctx.now()) - timeoutMs * 2).toISOString();
  const stale = ctx.db.all(
    ctx.db.q.selectFrom("voice_requests").select("id").where("status", "=", "pending").where("created_at", "<", cutoff),
  );
  for (const { id } of stale) {
    const outcome: VoiceResult = {
      kind: "failed",
      requestId: id,
      transcript: null,
      reason: "interrupted",
      message: "This command was interrupted. Nothing was saved.",
    };
    ctx.db.run(
      ctx.db.q
        .updateTable("voice_requests")
        .set({ status: "failed", error_reason: "interrupted", result_json: JSON.stringify(outcome), completed_at: ctx.now() })
        .where("id", "=", id),
    );
    ctx.db.run(
      ctx.db.q.updateTable("ai_usage").set({ status: "uncertain", settled_at: ctx.now() }).where("request_id", "=", id).where("status", "=", "reserved"),
    );
  }
}

// ---------- Context for the model ----------

function boxInMoveOrNull(ctx: Ctx, moveId: string, boxId: string) {
  const box = ctx.db.get(ctx.db.q.selectFrom("boxes").selectAll().where("id", "=", boxId));
  return box && box.move_id === moveId ? box : null;
}

/** Only what disambiguation needs: box labels, the active box, a few items in it, any pending question. */
function buildContext(
  ctx: Ctx,
  moveId: string,
  activeBox: { id: string; label: string } | null,
  clarifies: { transcript: string | null; result_json: string | null } | undefined,
): string {
  const { db } = ctx;
  const labels = db
    .all(db.q.selectFrom("boxes").select("label").where("move_id", "=", moveId).orderBy("label").limit(60))
    .map((b) => b.label);
  const lines = [`Box labels in this move: ${labels.length ? labels.join(", ") : "(none)"}.`];
  if (activeBox) {
    const items = db
      .all(
        db.q
          .selectFrom("items")
          .select("description")
          .where("box_id", "=", activeBox.id)
          .orderBy("updated_at", "desc")
          .limit(15),
      )
      .map((i) => i.description);
    lines.push(`Active box: ${activeBox.label}. Recent items in it: ${items.length ? items.join("; ") : "(empty)"}.`);
  } else {
    lines.push("No active box is selected.");
  }
  if (clarifies?.result_json) {
    const previous = JSON.parse(clarifies.result_json) as VoiceResult;
    if (previous.kind === "clarification") {
      lines.push(
        `Previous command: "${clarifies.transcript ?? ""}". You asked: "${previous.question}". The mover is now answering; combine both into one command.`,
      );
    }
  }
  return lines.join("\n");
}

// ---------- Resolving the model's answer against real records ----------

const STOP_WORDS = new Set(["the", "a", "an", "this", "that", "my", "item", "one", "in", "box", "from", "of", "to"]);

function normalizeLabel(label: string) {
  return label.trim().replace(/^box\s+/i, "").trim();
}

function findBox(ctx: Ctx, moveId: string, spoken: string) {
  return ctx.db.get(
    ctx.db.q
      .selectFrom("boxes")
      .selectAll()
      .where("move_id", "=", moveId)
      .where(sql<boolean>`label = ${normalizeLabel(spoken)} COLLATE NOCASE`),
  );
}

/** Items whose description contains every meaningful word of the reference; active box first. */
function findItems(ctx: Ctx, moveId: string, reference: string, activeBoxId: string | null): ItemView[] {
  const words = reference
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  if (words.length === 0) return [];
  let query = ctx.db.q.selectFrom("items").select("id").where("move_id", "=", moveId);
  for (const word of words) {
    query = query.where(sql<boolean>`instr(lower(description), ${word}) > 0`);
  }
  const ids = ctx.db.all(query.limit(10)).map((r) => r.id);
  const items = ids.map((id) => toItemView(getItemRow(ctx, id)!));
  const inActive = activeBoxId ? items.filter((i) => i.boxId === activeBoxId) : [];
  return inActive.length > 0 ? inActive : items;
}

function describeItem(item: ItemView) {
  return `${item.description}${item.boxLabel ? ` in box ${item.boxLabel}` : " (no box)"}`;
}

const CONDITION_TEXT: Record<ObservedCondition, string> = {
  no_visible_damage: "no visible damage",
  existing_wear: "existing wear",
};

type ItemLookup = { kind: "found"; item: ItemView } | { kind: "none" } | { kind: "ambiguous"; question: string };

function lookupItem(ctx: Ctx, moveId: string, reference: string | null | undefined, activeBoxId: string | null): ItemLookup {
  if (!reference?.trim()) return { kind: "none" };
  const matches = findItems(ctx, moveId, reference, activeBoxId);
  if (matches.length === 1) return { kind: "found", item: matches[0] };
  if (matches.length === 0) return { kind: "none" };
  const options = matches.slice(0, 3).map(describeItem).join(", or ");
  return { kind: "ambiguous", question: `Which one do you mean: ${options}?` };
}

/**
 * Turns an interpretation into a proposal or a question. The model never chooses
 * record IDs: boxes and items are matched here, and anything uncertain becomes a question.
 */
export function resolveInterpretation(
  ctx: Ctx,
  moveId: string,
  context: VoiceContext,
  interpretation: Interpretation,
): Resolution {
  const activeBox = context.boxId ? boxInMoveOrNull(ctx, moveId, context.boxId) : null;
  const ask = (question: string): Resolution => ({ kind: "clarify", question });

  switch (interpretation.intent) {
    case "clarify":
      return ask(interpretation.question?.trim() || "Sorry, could you say that again?");

    case "unsupported":
      return {
        kind: "reject",
        reason: "unsupported",
        message: "I can record an item, move an item to a box, record its condition, or report damage.",
      };

    case "record_item": {
      const description = interpretation.description?.trim().replace(/\s+/g, " ");
      if (!description) return ask("What is the item?");
      if (description.length > MAX_DESCRIPTION) return ask("Please give a shorter description.");
      let box = activeBox;
      if (interpretation.box_label?.trim()) {
        const spoken = findBox(ctx, moveId, interpretation.box_label);
        if (!spoken) return ask(`I couldn't find box ${normalizeLabel(interpretation.box_label)}. Which box?`);
        if (activeBox && spoken.id !== activeBox.id) {
          return ask(`You said box ${spoken.label}, but your active box is ${activeBox.label}. Which box?`);
        }
        box = spoken;
      }
      if (box && box.status !== "open") {
        return { kind: "reject", reason: "box_sealed", message: `Box ${box.label} is ${box.status}. Reopen it first.` };
      }
      const condition = interpretation.condition ?? null;
      const args: ProposalArgs = {
        operation: "record_item",
        boxId: box?.id ?? null,
        description,
        category: interpretation.category?.trim() || null,
        fragile: interpretation.fragile === true,
        valuable: interpretation.valuable === true,
        condition,
        conditionNote: condition ? interpretation.condition_note?.trim() || null : null,
      };
      const flags = [args.fragile && "fragile", args.valuable && "valuable"].filter(Boolean).join(", ");
      const readback = [
        description,
        flags,
        box ? `box ${box.label}` : "no box",
        condition && CONDITION_TEXT[condition] + (args.conditionNote ? ` (${args.conditionNote})` : ""),
      ]
        .filter(Boolean)
        .join(", ");
      return { kind: "propose", args, readback: `Record ${readback}. Save?` };
    }

    case "assign_item_to_box": {
      const lookup = lookupItem(ctx, moveId, interpretation.item_reference, activeBox?.id ?? null);
      if (lookup.kind === "ambiguous") return ask(lookup.question);
      if (lookup.kind === "none") {
        const reference = interpretation.item_reference?.trim();
        if (!reference) return ask("Which item should I move?");
        // "Put the lamp in box A" with no lamp on record most likely means a new item.
        // Offer that explicitly; the mover still has to confirm.
        const asNew = resolveInterpretation(ctx, moveId, context, {
          ...interpretation,
          intent: "record_item",
          description: reference.charAt(0).toUpperCase() + reference.slice(1),
        });
        if (asNew.kind !== "propose") return asNew;
        return {
          ...asNew,
          readback: `I couldn't find an existing ${reference}. ${asNew.readback.replace(/^Record /, "Record a new item: ")}`,
        };
      }
      if (!interpretation.box_label?.trim()) return ask(`Which box should the ${lookup.item.description} go into?`);
      const target = findBox(ctx, moveId, interpretation.box_label);
      if (!target) return ask(`I couldn't find box ${normalizeLabel(interpretation.box_label)}. Which box?`);
      if (target.id === lookup.item.boxId) {
        return { kind: "reject", reason: "already_there", message: `The ${lookup.item.description} is already in box ${target.label}.` };
      }
      return {
        kind: "propose",
        args: { operation: "assign_item_to_box", itemId: lookup.item.id, expectedRevision: lookup.item.revision, boxId: target.id },
        readback: `Move ${describeItem(lookup.item)} to box ${target.label}. Save?`,
      };
    }

    case "record_condition": {
      const lookup = lookupItem(ctx, moveId, interpretation.item_reference, activeBox?.id ?? null);
      if (lookup.kind === "ambiguous") return ask(lookup.question);
      if (lookup.kind === "none") return ask("Which item is this about?");
      if (!interpretation.condition) return ask(`Does the ${lookup.item.description} have any visible damage or wear?`);
      const note = interpretation.condition_note?.trim() || null;
      return {
        kind: "propose",
        args: { operation: "record_condition", itemId: lookup.item.id, condition: interpretation.condition, note },
        readback: `Record ${describeItem(lookup.item)}: ${CONDITION_TEXT[interpretation.condition]}${note ? ` (${note})` : ""}. Save?`,
      };
    }

    case "report_damage": {
      const report = (interpretation.damage_report ?? interpretation.transcript).trim();
      if (!report) return ask("What is damaged?");
      const lookup = lookupItem(ctx, moveId, interpretation.item_reference, activeBox?.id ?? null);
      if (lookup.kind === "ambiguous") return ask(lookup.question);
      // No match is allowed: the incident opens awaiting identification. The system never guesses.
      const item = lookup.kind === "found" ? lookup.item : null;
      return {
        kind: "propose",
        args: { operation: "report_damage", itemId: item?.id ?? null, report: report.slice(0, 1000) },
        readback: item
          ? `Report damage to ${describeItem(item)}: ${report}. The item will be put on hold. Save?`
          : `Report damage, item not identified: ${report}. A reviewer will identify the item. Save?`,
      };
    }
  }
}

function createProposal(
  ctx: Ctx,
  actor: Actor,
  input: SubmitVoiceInput,
  requestId: string,
  resolution: Extract<Resolution, { kind: "propose" }>,
): ProposalView {
  const { db } = ctx;
  const now = ctx.now();
  // One open proposal per mover and move: a new command replaces any unanswered one.
  db.run(
    db.q
      .updateTable("voice_proposals")
      .set({ status: "cancelled", decided_at: now })
      .where("user_id", "=", actor.id)
      .where("move_id", "=", input.moveId)
      .where("status", "=", "pending"),
  );
  const id = ctx.newId();
  const expiresAt = new Date(Date.parse(now) + PROPOSAL_TTL_MS).toISOString();
  db.run(
    db.q.insertInto("voice_proposals").values({
      id,
      request_id: requestId,
      move_id: input.moveId,
      user_id: actor.id,
      operation: resolution.args.operation,
      args_json: JSON.stringify(resolution.args),
      readback: resolution.readback,
      context_box_id: input.context.boxId,
      status: "pending",
      outcome_json: null,
      expires_at: expiresAt,
      created_at: now,
      decided_at: null,
    }),
  );
  return { id, operation: resolution.args.operation, readback: resolution.readback, status: "pending", expiresAt };
}

// ---------- Confirming ----------

export type ConfirmOutcome =
  | { operation: "record_item"; item: ItemView; message: string }
  | { operation: "assign_item_to_box"; item: ItemView; message: string }
  | { operation: "record_condition"; itemId: string; message: string }
  | { operation: "report_damage"; incident: IncidentSummary; message: string };

function loadOwnProposal(ctx: Ctx, actor: Actor, proposalId: string) {
  const proposal = ctx.db.get(ctx.db.q.selectFrom("voice_proposals").selectAll().where("id", "=", proposalId));
  if (!proposal) throw notFound("Proposal");
  if (proposal.user_id !== actor.id) throw forbidden("Only the mover who spoke can answer this proposal.");
  return proposal;
}

function closeProposal(ctx: Ctx, proposalId: string, status: "cancelled" | "expired") {
  ctx.db.transaction(() =>
    ctx.db.run(
      ctx.db.q
        .updateTable("voice_proposals")
        .set({ status, decided_at: ctx.now() })
        .where("id", "=", proposalId)
        .where("status", "=", "pending"),
    ),
  );
}

/**
 * Executes a pending proposal through the same services as manual entry, after
 * re-checking it: it must be unexpired, from the same active box, and still valid
 * against current records (stale revisions return a conflict). Confirming twice
 * returns the first outcome.
 */
export function confirmProposal(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  input: { proposalId: string; contextBoxId: string | null },
): ConfirmOutcome {
  const proposal = loadOwnProposal(ctx, actor, input.proposalId);
  if (proposal.status === "confirmed") return JSON.parse(proposal.outcome_json!) as ConfirmOutcome;
  if (proposal.status !== "pending") {
    throw new DomainError("conflict", "proposal_closed", `This proposal was ${proposal.status}. Nothing was saved.`);
  }
  if (proposal.expires_at <= ctx.now()) {
    closeProposal(ctx, proposal.id, "expired");
    throw new DomainError("conflict", "proposal_expired", "That proposal expired. Nothing was saved. Please say it again.");
  }
  if ((input.contextBoxId ?? null) !== proposal.context_box_id) {
    closeProposal(ctx, proposal.id, "cancelled");
    throw new DomainError(
      "conflict",
      "context_changed",
      "The active box changed after you spoke, so this proposal was cancelled. Nothing was saved.",
    );
  }

  return runAction(ctx, actor, { actionId, operation: "voice.confirm", fingerprint: { proposalId: proposal.id } }, () => {
    // Re-read inside the write transaction: a concurrent confirm may have won.
    const current = loadOwnProposal(ctx, actor, proposal.id);
    if (current.status === "confirmed") return JSON.parse(current.outcome_json!) as ConfirmOutcome;
    if (current.status !== "pending") {
      throw new DomainError("conflict", "proposal_closed", `This proposal was ${current.status}. Nothing was saved.`);
    }
    requireMovePermission(ctx, actor, current.move_id, "inventory.write");
    const outcome = execute(ctx, actor, current.id, current.move_id, JSON.parse(current.args_json) as ProposalArgs);
    ctx.db.run(
      ctx.db.q
        .updateTable("voice_proposals")
        .set({ status: "confirmed", outcome_json: JSON.stringify(outcome), decided_at: ctx.now() })
        .where("id", "=", current.id),
    );
    return outcome;
  }).outcome;
}

/** Derived action IDs make each underlying write idempotent per proposal. */
function execute(ctx: Ctx, actor: Actor, proposalId: string, moveId: string, args: ProposalArgs): ConfirmOutcome {
  switch (args.operation) {
    case "record_item": {
      const item = recordItem(ctx, actor, `${proposalId}:item`, {
        moveId,
        boxId: args.boxId,
        description: args.description,
        category: args.category,
        fragile: args.fragile,
        valuable: args.valuable,
      });
      if (args.condition) {
        recordObservation(ctx, actor, `${proposalId}:condition`, {
          itemId: item.id,
          stage: "packing",
          condition: args.condition,
          note: args.conditionNote,
        });
      }
      return {
        operation: "record_item",
        item,
        message: `Saved: ${item.description}${item.boxLabel ? ` in box ${item.boxLabel}` : ""}.`,
      };
    }
    case "assign_item_to_box": {
      const item = assignItemToBox(ctx, actor, `${proposalId}:assign`, {
        itemId: args.itemId,
        expectedRevision: args.expectedRevision,
        boxId: args.boxId,
      });
      return { operation: "assign_item_to_box", item, message: `Saved: ${item.description} moved to box ${item.boxLabel}.` };
    }
    case "record_condition": {
      recordObservation(ctx, actor, `${proposalId}:condition`, {
        itemId: args.itemId,
        stage: "packing",
        condition: args.condition,
        note: args.note,
      });
      return { operation: "record_condition", itemId: args.itemId, message: "Saved: condition recorded." };
    }
    case "report_damage": {
      const incident = reportDamage(ctx, actor, `${proposalId}:incident`, { moveId, itemId: args.itemId, report: args.report });
      return {
        operation: "report_damage",
        incident,
        message: incident.itemId
          ? "Saved: damage reported. The item is on hold. Please take a photo."
          : "Saved: damage reported. A reviewer will identify the item. Please take a photo.",
      };
    }
  }
}

export function cancelProposal(ctx: Ctx, actor: Actor, input: { proposalId: string }): ProposalView {
  const proposal = loadOwnProposal(ctx, actor, input.proposalId);
  if (proposal.status === "pending") closeProposal(ctx, proposal.id, "cancelled");
  const after = loadOwnProposal(ctx, actor, input.proposalId);
  return { id: after.id, operation: after.operation, readback: after.readback, status: after.status, expiresAt: after.expires_at };
}
