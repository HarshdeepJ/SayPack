import type { AiProvider } from "@/domain/ai";
import { GeminiProvider } from "./gemini";
import { MockProvider } from "./mock";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

/**
 * Real Gemini calls happen only when explicitly enabled with SAYPACK_AI_PROVIDER=gemini
 * and a GEMINI_API_KEY. Everything else uses the free mock.
 */
export function createProvider(env: NodeJS.ProcessEnv = process.env): AiProvider {
  if (env.SAYPACK_AI_PROVIDER === "gemini") {
    if (!env.GEMINI_API_KEY) throw new Error("SAYPACK_AI_PROVIDER=gemini needs GEMINI_API_KEY in .env.local");
    return new GeminiProvider(env.GEMINI_API_KEY, env.SAYPACK_GEMINI_MODEL || DEFAULT_GEMINI_MODEL, env.SAYPACK_GEMINI_THINKING);
  }
  return new MockProvider();
}
