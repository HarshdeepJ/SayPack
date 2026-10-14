import type { AiProvider, AssessInput, Assessment, InterpretInput, InterpretResult, Interpretation } from "@/domain/ai";

/**
 * Free stand-in for Gemini during development and tests. It understands typed commands:
 *   "Blue vase, box A, fragile, no visible damage"   record an item
 *   "move blue vase to box B"                         move an item
 *   "condition blue vase: wear, chip on base"         record condition
 *   "damage blue vase: crack on rim" / "damage: something rattles"
 * Test hooks: "simulate timeout", "simulate error", "simulate garbage".
 * Audio cannot be transcribed; set SAYPACK_MOCK_AUDIO_TEXT to treat every clip as that text.
 * Photos cannot be seen either. assessDamage answers from the report text: it says
 * "damage visible" unless the report contains "simulate no damage" or "simulate unclear".
 */
export class MockProvider implements AiProvider {
  readonly name = "mock";
  readonly model = "mock";
  readonly overheadChars = 0;
  readonly assessOverheadChars = 0;

  constructor(private readonly audioText = process.env.SAYPACK_MOCK_AUDIO_TEXT) {}

  async interpret(input: InterpretInput): Promise<InterpretResult> {
    const text = input.text ?? this.audioText;
    if (!text) {
      return ok({
        transcript: "(audio)",
        intent: "clarify",
        question: "The mock assistant can't hear audio. Type the command instead.",
      });
    }
    const lower = text.trim().toLowerCase();
    if (lower === "simulate timeout") {
      return new Promise((resolve) =>
        input.signal.addEventListener("abort", () => resolve({ kind: "unknown", reason: "timeout" })),
      );
    }
    if (lower === "simulate error") return { kind: "rejected", reason: "mock provider error" };
    if (lower === "simulate garbage") return { kind: "ok", raw: { nonsense: true }, usage: null };
    return ok(parse(text.trim()));
  }

  async assessDamage(input: AssessInput): Promise<InterpretResult> {
    const report = input.report.toLowerCase();
    if (report.includes("simulate error")) return { kind: "rejected", reason: "mock provider error" };
    const verdict: Assessment["verdict"] = report.includes("simulate no damage")
      ? "no_damage_visible"
      : report.includes("simulate unclear")
        ? "inconclusive"
        : "damage_visible";
    const raw: Assessment = {
      verdict,
      summary:
        verdict === "damage_visible"
          ? `Simulated check: damage matching "${input.report}" would be described here.`
          : verdict === "no_damage_visible"
            ? "Simulated check: no damage visible."
            : "Simulated check: the photo is too unclear to tell.",
      observations: [`${input.photos.length} photo(s) received${input.baseline ? ", plus the baseline photo" : ""}.`],
      severity: verdict === "damage_visible" ? "minor" : null,
      matches_report: verdict === "damage_visible" ? "yes" : "unclear",
      limitations: "The mock assistant cannot see photos.",
      retake_request: verdict === "inconclusive" ? "Take a close-up of the damaged area in good light." : null,
    };
    return { kind: "ok", raw, usage: { inputTokens: 0, audioTokens: 0, outputTokens: 0 } };
  }
}

function ok(raw: Partial<Interpretation> & Pick<Interpretation, "transcript" | "intent">): InterpretResult {
  return { kind: "ok", raw, usage: { inputTokens: 0, audioTokens: 0, outputTokens: 0 } };
}

function parse(text: string): Partial<Interpretation> & Pick<Interpretation, "transcript" | "intent"> {
  const transcript = text;
  let m = /^damage\s*(.*?)\s*:\s*(.+)$/i.exec(text);
  if (m) return { transcript, intent: "report_damage", item_reference: m[1] || null, damage_report: m[2] };
  m = /^move\s+(.+?)\s+to\s+(?:box\s+)?(.+)$/i.exec(text);
  if (m) return { transcript, intent: "assign_item_to_box", item_reference: m[1], box_label: m[2] };
  m = /^condition\s+(.+?)\s*:\s*(no visible damage|no damage|wear|worn)\s*,?\s*(.*)$/i.exec(text);
  if (m) {
    return {
      transcript,
      intent: "record_condition",
      item_reference: m[1],
      condition: /wear|worn/i.test(m[2]) ? "existing_wear" : "no_visible_damage",
      condition_note: m[3] || null,
    };
  }
  if (text.endsWith("?")) return { transcript, intent: "clarify", question: "What would you like to do?" };

  const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
  const result: Partial<Interpretation> & Pick<Interpretation, "transcript" | "intent"> = {
    transcript,
    intent: "record_item",
  };
  const description: string[] = [];
  for (const part of parts) {
    const box = /^box\s+(.+)$/i.exec(part);
    if (box) result.box_label = box[1];
    else if (/^fragile$/i.test(part)) result.fragile = true;
    else if (/^valuable$/i.test(part)) result.valuable = true;
    else if (/^no (visible )?damage$/i.test(part)) result.condition = "no_visible_damage";
    else if (/^(existing )?wear\b|^worn\b/i.test(part)) {
      result.condition = "existing_wear";
      result.condition_note = part.replace(/^(existing )?wear|^worn/i, "").replace(/^[\s:-]+/, "") || null;
    } else description.push(part);
  }
  result.description = description.join(", ") || null;
  return result;
}
