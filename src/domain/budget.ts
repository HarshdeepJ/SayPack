import { recordAudit, runAction } from "./actions";
import {
  AUDIO_TOKENS_PER_SECOND,
  IMAGE_TOKENS_ESTIMATE,
  MAX_OUTPUT_TOKENS,
  MODEL_PRICING,
  type ModelPricing,
  type ProviderUsage,
} from "./ai";
import { DomainError, invalid, type Actor, type Ctx } from "./core";
import { requireAdmin } from "./identity";

const MICRO = 1_000_000;
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;
/** Reservations are padded so token-estimate error rarely pushes spend past the allowance. */
const ESTIMATE_MARGIN = 1.25;

export interface AiSettingsView {
  allowanceSgd: number;
  usdToSgd: number;
  updatedAt: string;
}

export interface UsageSummary extends AiSettingsView {
  /** Final costs of completed calls. */
  settledSgd: number;
  /** Held for calls in flight, plus calls whose outcome is unknown (charged conservatively). */
  heldSgd: number;
  remainingSgd: number;
  requests: number;
  uncertainRequests: number;
  breakerOpenUntil: string | null;
  exhausted: boolean;
}

export function pricingFor(model: string): ModelPricing {
  const pricing = MODEL_PRICING[model];
  if (!pricing) throw new Error(`No pricing configured for model ${model}; add it to MODEL_PRICING before use.`);
  return pricing;
}

function settings(ctx: Ctx) {
  return ctx.db.get(ctx.db.q.selectFrom("ai_settings").selectAll().where("id", "=", 1))!;
}

/** Micro-SGD already committed: settled costs plus every outstanding or uncertain reservation. */
function committedMicroSgd(ctx: Ctx) {
  const { db } = ctx;
  const row = db.get(
    db.q
      .selectFrom("ai_usage")
      .select((eb) => [
        eb.fn
          .sum<number>(eb.case().when("status", "=", "settled").then(eb.ref("cost_micro_sgd")).else(0).end())
          .as("settled"),
        eb.fn
          .sum<number>(
            eb.case().when("status", "in", ["reserved", "uncertain"]).then(eb.ref("reserved_micro_sgd")).else(0).end(),
          )
          .as("held"),
        eb.fn.countAll<number>().as("requests"),
        eb.fn.sum<number>(eb.case().when("status", "=", "uncertain").then(1).else(0).end()).as("uncertain"),
      ]),
  );
  return {
    settled: Number(row?.settled ?? 0),
    held: Number(row?.held ?? 0),
    requests: Number(row?.requests ?? 0),
    uncertain: Number(row?.uncertain ?? 0),
  };
}

export function usageSummary(ctx: Ctx): UsageSummary {
  const s = settings(ctx);
  const c = committedMicroSgd(ctx);
  const remaining = s.allowance_micro_sgd - c.settled - c.held;
  return {
    allowanceSgd: s.allowance_micro_sgd / MICRO,
    usdToSgd: s.usd_to_sgd,
    updatedAt: s.updated_at,
    settledSgd: c.settled / MICRO,
    heldSgd: c.held / MICRO,
    remainingSgd: Math.max(remaining, 0) / MICRO,
    requests: c.requests,
    uncertainRequests: c.uncertain,
    breakerOpenUntil: s.breaker_open_until && s.breaker_open_until > ctx.now() ? s.breaker_open_until : null,
    exhausted: remaining <= 0,
  };
}

export function adminUsageSummary(ctx: Ctx, actor: Actor): UsageSummary {
  requireAdmin(actor);
  return usageSummary(ctx);
}

/** Worst-case cost of one call: full input plus the maximum output, with a safety margin. */
export function estimateMicroSgd(
  pricing: ModelPricing,
  usdToSgd: number,
  input: { audioSeconds: number; promptChars: number; images?: number },
): number {
  const audioTokens = Math.ceil(input.audioSeconds * AUDIO_TOKENS_PER_SECOND);
  // Images are billed at the text/image input rate.
  const textTokens = Math.ceil(input.promptChars / 3) + (input.images ?? 0) * IMAGE_TOKENS_ESTIMATE;
  const usd =
    (audioTokens * pricing.audioInputUsd + textTokens * pricing.textInputUsd + MAX_OUTPUT_TOKENS * pricing.outputUsd) /
    1_000_000;
  return Math.ceil(usd * usdToSgd * ESTIMATE_MARGIN * MICRO);
}

export function costMicroSgd(pricing: ModelPricing, usdToSgd: number, usage: ProviderUsage): number {
  const textTokens = Math.max(usage.inputTokens - usage.audioTokens, 0);
  const usd =
    (usage.audioTokens * pricing.audioInputUsd + textTokens * pricing.textInputUsd + usage.outputTokens * pricing.outputUsd) /
    1_000_000;
  return Math.ceil(usd * usdToSgd * MICRO);
}

/**
 * Reserves the estimate inside the caller's transaction. Concurrent requests are
 * serialized by the write lock, so two reservations cannot both spend the last of the allowance.
 */
export function reserve(
  ctx: Ctx,
  input: {
    requestId: string;
    operation: "interpret" | "assess_damage";
    model: string;
    pricing: ModelPricing;
    estimateMicroSgd: number;
  },
): string {
  const s = settings(ctx);
  if (s.breaker_open_until && s.breaker_open_until > ctx.now()) {
    throw new DomainError(
      "unavailable",
      "provider_unavailable",
      "Voice is paused after repeated AI errors. Use manual entry; it will retry automatically in a minute.",
    );
  }
  const c = committedMicroSgd(ctx);
  const remaining = s.allowance_micro_sgd - c.settled - c.held;
  if (remaining <= 0 || remaining < input.estimateMicroSgd) {
    throw new DomainError(
      "unavailable",
      "allowance_exhausted",
      "The AI allowance is used up. Manual entry and review still work.",
    );
  }
  const id = ctx.newId();
  ctx.db.run(
    ctx.db.q.insertInto("ai_usage").values({
      id,
      request_id: input.requestId,
      operation: input.operation,
      model: input.model,
      status: "reserved",
      reserved_micro_sgd: input.estimateMicroSgd,
      cost_micro_sgd: null,
      input_tokens: null,
      output_tokens: null,
      pricing_version: input.pricing.version,
      usd_to_sgd: s.usd_to_sgd,
      created_at: ctx.now(),
      settled_at: null,
    }),
  );
  return id;
}

/** Records the actual cost. Without provider usage, the reservation is kept as the cost. */
export function settle(ctx: Ctx, usageId: string, model: string, usage: ProviderUsage | null) {
  const row = ctx.db.get(ctx.db.q.selectFrom("ai_usage").selectAll().where("id", "=", usageId))!;
  const cost = usage ? costMicroSgd(pricingFor(model), row.usd_to_sgd, usage) : row.reserved_micro_sgd;
  ctx.db.run(
    ctx.db.q
      .updateTable("ai_usage")
      .set({
        status: "settled",
        cost_micro_sgd: cost,
        input_tokens: usage?.inputTokens ?? null,
        output_tokens: usage?.outputTokens ?? null,
        settled_at: ctx.now(),
      })
      .where("id", "=", usageId),
  );
}

/** Completion unknown: keep the full reservation charged rather than guess it was free. */
export function markUncertain(ctx: Ctx, usageId: string) {
  ctx.db.run(ctx.db.q.updateTable("ai_usage").set({ status: "uncertain", settled_at: ctx.now() }).where("id", "=", usageId));
}

/** The provider refused the call before doing work: nothing billed. */
export function release(ctx: Ctx, usageId: string) {
  ctx.db.run(
    ctx.db.q
      .updateTable("ai_usage")
      .set({ status: "released", cost_micro_sgd: 0, settled_at: ctx.now() })
      .where("id", "=", usageId),
  );
}

export function recordProviderSuccess(ctx: Ctx) {
  ctx.db.run(
    ctx.db.q.updateTable("ai_settings").set({ consecutive_failures: 0, breaker_open_until: null }).where("id", "=", 1),
  );
}

/** After repeated failures, stop calling the provider for a cooldown period. */
export function recordProviderFailure(ctx: Ctx) {
  const s = settings(ctx);
  const failures = s.consecutive_failures + 1;
  ctx.db.run(
    ctx.db.q
      .updateTable("ai_settings")
      .set({
        consecutive_failures: failures,
        breaker_open_until:
          failures >= BREAKER_THRESHOLD ? new Date(Date.parse(ctx.now()) + BREAKER_COOLDOWN_MS).toISOString() : null,
      })
      .where("id", "=", 1),
  );
}

export function updateAiSettings(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  input: { allowanceSgd: number; usdToSgd: number },
): UsageSummary {
  requireAdmin(actor);
  if (!(input.allowanceSgd >= 0 && input.allowanceSgd <= 1000)) {
    throw invalid("bad_allowance", "The allowance must be between S$0 and S$1000.");
  }
  if (!(input.usdToSgd > 0.5 && input.usdToSgd < 5)) throw invalid("bad_rate", "Enter a realistic USD to SGD rate.");
  return runAction(ctx, actor, { actionId, operation: "ai.update_settings", fingerprint: input }, () => {
    const before = settings(ctx);
    ctx.db.run(
      ctx.db.q
        .updateTable("ai_settings")
        .set({
          allowance_micro_sgd: Math.round(input.allowanceSgd * MICRO),
          usd_to_sgd: input.usdToSgd,
          updated_at: ctx.now(),
          updated_by: actor.id,
        })
        .where("id", "=", 1),
    );
    recordAudit(ctx, {
      moveId: null,
      actorId: actor.id,
      action: "ai.settings_updated",
      recordType: "ai_settings",
      recordId: "1",
      before: { allowanceSgd: before.allowance_micro_sgd / MICRO, usdToSgd: before.usd_to_sgd },
      after: input,
      actionId,
    });
    return usageSummary(ctx);
  }).outcome;
}
