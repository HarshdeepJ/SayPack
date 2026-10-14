import {
  ASSESSMENT_JSON_SCHEMA,
  INTERPRETATION_JSON_SCHEMA,
  MAX_OUTPUT_TOKENS,
  type AiProvider,
  type AssessInput,
  type InterpretInput,
  type InterpretResult,
} from "@/domain/ai";
import { ASSESS_PROMPT, SYSTEM_PROMPT } from "./prompt";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
    promptTokensDetails?: { modality?: string; tokenCount?: number }[];
  };
}

/**
 * Gemini generateContent with structured JSON output. The API key stays on the server.
 * Voice commands are verified against the real API; photo checks: run `npm run gemini-check -- --photo <file>`.
 */
export class GeminiProvider implements AiProvider {
  readonly name = "gemini";
  readonly overheadChars = SYSTEM_PROMPT.length + 2000; // instructions plus the JSON schema
  readonly assessOverheadChars = ASSESS_PROMPT.length + 2000;

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    /** Optional thinkingConfig.thinkingLevel; thinking tokens are billed as output. */
    private readonly thinkingLevel?: string,
  ) {}

  async interpret(input: InterpretInput): Promise<InterpretResult> {
    const parts: Record<string, unknown>[] = [{ text: `Context:
${input.context}` }];
    if (input.audio) {
      parts.push({ text: "The mover's command is in this audio clip:" });
      parts.push(inline(input.audio.bytes, input.audio.mimeType));
    } else {
      parts.push({ text: `The mover's typed command: ${input.text}` });
    }
    return this.generate(SYSTEM_PROMPT, parts, INTERPRETATION_JSON_SCHEMA, input.signal);
  }

  async assessDamage(input: AssessInput): Promise<InterpretResult> {
    const parts: Record<string, unknown>[] = [
      { text: `Item: ${input.itemDescription ?? "(not identified yet)"}
Mover's report: ${input.report}` },
    ];
    if (input.baseline) {
      parts.push({ text: "BASELINE photo, taken before packing:" });
      parts.push(inline(input.baseline.bytes, input.baseline.mimeType));
    }
    input.photos.forEach((photo, i) => {
      parts.push({ text: `DAMAGE photo ${i + 1} of ${input.photos.length}:` });
      parts.push(inline(photo.bytes, photo.mimeType));
    });
    return this.generate(ASSESS_PROMPT, parts, ASSESSMENT_JSON_SCHEMA, input.signal);
  }

  private async generate(
    systemPrompt: string,
    parts: Record<string, unknown>[],
    schema: object,
    signal: AbortSignal,
  ): Promise<InterpretResult> {
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        responseMimeType: "application/json",
        responseJsonSchema: schema,
        ...(this.thinkingLevel ? { thinkingConfig: { thinkingLevel: this.thinkingLevel } } : {}),
      },
    };

    let response: Response;
    try {
      response = await fetch(`${ENDPOINT}/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // Timeout or network failure: the request may still have been processed and billed.
      return { kind: "unknown", reason: error instanceof Error ? error.name : "network" };
    }

    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after")) || undefined;
      const detail = await response.text().catch(() => "");
      return { kind: "rejected", reason: `HTTP ${response.status}: ${detail.slice(0, 300)}`, retryAfterSeconds: retryAfter };
    }

    let json: GeminiResponse;
    try {
      json = (await response.json()) as GeminiResponse;
    } catch {
      return { kind: "unknown", reason: "unreadable response" };
    }
    const meta = json.usageMetadata ?? {};
    const inputTokens = meta.promptTokenCount ?? 0;
    const usage = {
      inputTokens,
      audioTokens: meta.promptTokensDetails?.find((d) => d.modality === "AUDIO")?.tokenCount ?? 0,
      // Thinking tokens are billed as output.
      outputTokens:
        meta.totalTokenCount !== undefined
          ? Math.max(meta.totalTokenCount - inputTokens, 0)
          : (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
    };
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    let raw: unknown = null;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = null; // fails validation downstream as an invalid result
    }
    return { kind: "ok", raw, usage: json.usageMetadata ? usage : null };
  }
}

function inline(bytes: Uint8Array, mimeType: string) {
  return { inlineData: { mimeType, data: Buffer.from(bytes).toString("base64") } };
}
