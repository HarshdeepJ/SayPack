import { z } from "zod";

/**
 * What the model returns. It is untrusted input: the domain validates every field,
 * resolves references against the database, and never executes it directly.
 * Flat with nullable fields, which structured-output modes handle most reliably.
 */
export const Interpretation = z.object({
  transcript: z.string().max(2000),
  intent: z.enum(["record_item", "assign_item_to_box", "record_condition", "report_damage", "clarify", "unsupported"]),
  description: z.string().max(300).nullish(),
  category: z.string().max(100).nullish(),
  fragile: z.boolean().nullish(),
  valuable: z.boolean().nullish(),
  box_label: z.string().max(60).nullish(),
  item_reference: z.string().max(300).nullish(),
  condition: z.enum(["no_visible_damage", "existing_wear"]).nullish(),
  condition_note: z.string().max(500).nullish(),
  damage_report: z.string().max(1000).nullish(),
  question: z.string().max(300).nullish(),
});
export type Interpretation = z.infer<typeof Interpretation>;

/** JSON Schema sent to the provider for structured output. Mirrors Interpretation. */
export const INTERPRETATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    transcript: { type: "string", description: "What the mover said, verbatim." },
    intent: {
      type: "string",
      enum: ["record_item", "assign_item_to_box", "record_condition", "report_damage", "clarify", "unsupported"],
    },
    description: { type: ["string", "null"], description: "New item's description, without box or condition words." },
    category: { type: ["string", "null"] },
    fragile: { type: ["boolean", "null"], description: "Only if the mover said fragile/breakable." },
    valuable: { type: ["boolean", "null"], description: "Only if the mover said valuable." },
    box_label: { type: ["string", "null"], description: "Box label only if explicitly spoken, e.g. 'A' for 'box A'." },
    item_reference: { type: ["string", "null"], description: "Words identifying an existing item." },
    condition: { type: ["string", "null"], enum: ["no_visible_damage", "existing_wear", null] },
    condition_note: { type: ["string", "null"] },
    damage_report: { type: ["string", "null"], description: "The damage, in the mover's words." },
    question: { type: ["string", "null"], description: "A short question when the command is ambiguous." },
  },
  required: ["transcript", "intent"],
} as const;

/**
 * What the model reports about damage photos. Untrusted like Interpretation: it is
 * validated, stored as an observation, and never changes holds or decisions.
 */
export const Assessment = z.object({
  verdict: z.enum(["damage_visible", "no_damage_visible", "inconclusive"]),
  summary: z.string().max(300),
  observations: z.array(z.string().max(300)).max(6),
  severity: z.enum(["minor", "moderate", "severe"]).nullish(),
  matches_report: z.enum(["yes", "no", "unclear"]),
  limitations: z.string().max(500).nullish(),
  retake_request: z.string().max(300).nullish(),
});
export type Assessment = z.infer<typeof Assessment>;

/** JSON Schema sent to the provider for structured output. Mirrors Assessment. */
export const ASSESSMENT_JSON_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["damage_visible", "no_damage_visible", "inconclusive"],
      description: "inconclusive when the photo is blurry, dark, or does not show the reported area.",
    },
    summary: { type: "string", description: "One short sentence a mover hears read aloud." },
    observations: {
      type: "array",
      items: { type: "string" },
      description: "Up to 6 specific visible details: what, where, approximate size.",
    },
    severity: { type: ["string", "null"], enum: ["minor", "moderate", "severe", null] },
    matches_report: {
      type: "string",
      enum: ["yes", "no", "unclear"],
      description: "Whether the visible damage matches what the mover reported.",
    },
    limitations: { type: ["string", "null"], description: "What the photos cannot show." },
    retake_request: {
      type: ["string", "null"],
      description: "If a better photo is needed, a short instruction, e.g. 'Close-up of the rim in daylight'.",
    },
  },
  required: ["verdict", "summary", "observations", "matches_report"],
} as const;

export interface AssessInput {
  /** Damage photos, newest last; at most MAX_ASSESSED_PHOTOS. */
  photos: { bytes: Uint8Array; mimeType: string }[];
  /** The item's photo from before packing, for comparison. */
  baseline: { bytes: Uint8Array; mimeType: string } | null;
  itemDescription: string | null;
  report: string;
  signal: AbortSignal;
}

export interface InterpretInput {
  audio?: { bytes: Uint8Array; mimeType: string; seconds: number };
  text?: string;
  /** Short context the model may use: active box, boxes, recent items, a pending question. */
  context: string;
  signal: AbortSignal;
}

export interface ProviderUsage {
  inputTokens: number;
  audioTokens: number;
  outputTokens: number;
}

export type InterpretResult =
  | { kind: "ok"; raw: unknown; usage: ProviderUsage | null }
  /** The provider answered with an error: no completion, nothing billed. */
  | { kind: "rejected"; reason: string; retryAfterSeconds?: number }
  /** No answer (timeout, network): the call may or may not have been billed. */
  | { kind: "unknown"; reason: string };

/** Provider adapter. Swappable: Gemini in production, a mock in development and tests. */
export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** Characters of fixed instructions sent with every call; used for the cost estimate. */
  readonly overheadChars: number;
  interpret(input: InterpretInput): Promise<InterpretResult>;
  /** Same result shape: raw is an untrusted Assessment. */
  assessDamage(input: AssessInput): Promise<InterpretResult>;
  /** Characters of fixed instructions for assessDamage; used for the cost estimate. */
  readonly assessOverheadChars: number;
}

/** Prices in USD per 1M tokens. Check against the provider's pricing page before real use. */
export interface ModelPricing {
  textInputUsd: number;
  audioInputUsd: number;
  outputUsd: number;
  version: string;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gemini-3.5-flash-lite": {
    textInputUsd: 0.3,
    audioInputUsd: 0.3,
    outputUsd: 2.5,
    version: "ai.google.dev/gemini-api/docs/pricing as read 2026-10-06",
  },
  "gemini-2.5-flash-lite": {
    textInputUsd: 0.1,
    audioInputUsd: 0.3,
    outputUsd: 0.4,
    version: "ai.google.dev/gemini-api/docs/pricing as read 2026-10-06",
  },
  mock: { textInputUsd: 0, audioInputUsd: 0, outputUsd: 0, version: "mock" },
};

export const AUDIO_TOKENS_PER_SECOND = 32;
export const MAX_OUTPUT_TOKENS = 1024;
export const MAX_AUDIO_SECONDS = 20;
/**
 * Worst-case input tokens per photo for the estimate. Gemini bills images at a fixed
 * token count per image or tile depending on the model's media resolution; settling
 * uses the reported count, so this only has to be a safe upper bound.
 */
export const IMAGE_TOKENS_ESTIMATE = 2500;
/** Newest damage photos sent per check, plus one baseline photo. */
export const MAX_ASSESSED_PHOTOS = 3;
