// One real Gemini call through the app's adapter, to verify the request format and cost.
//   npm run gemini-check -- "Blue vase, box A, fragile, no visible damage"
//   npm run gemini-check -- --photo damage.jpg "Crack on the rim"      (damage photo check)
// Reads GEMINI_API_KEY (and optional SAYPACK_GEMINI_MODEL / SAYPACK_GEMINI_THINKING) from .env.local.
// Costs a fraction of a cent; it is not counted in the app's allowance.
import fs from "node:fs";
import { GeminiProvider } from "@/ai/gemini";
import { DEFAULT_GEMINI_MODEL } from "@/ai/provider";
import { Assessment, Interpretation, type InterpretResult } from "@/domain/ai";
import { costMicroSgd, pricingFor } from "@/domain/budget";
import { sniffImageType } from "@/domain/evidence";

async function main() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set in .env.local");
  const model = process.env.SAYPACK_GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const args = process.argv.slice(2);
  const photoAt = args.indexOf("--photo");
  const photoPath = photoAt >= 0 ? args.splice(photoAt, 2)[1] : null;
  const provider = new GeminiProvider(key, model, process.env.SAYPACK_GEMINI_THINKING);
  const started = Date.now();
  let result: InterpretResult;
  let schema: typeof Interpretation | typeof Assessment = Interpretation;

  if (photoPath) {
    const bytes = new Uint8Array(fs.readFileSync(photoPath));
    const mimeType = sniffImageType(bytes);
    if (!mimeType) throw new Error("The photo must be a JPEG, PNG or WebP file.");
    const report = args.join(" ") || "Crack on the rim";
    console.log(`Model: ${model}\nPhoto: ${photoPath} (${bytes.byteLength} bytes)\nReport: "${report}"\n`);
    schema = Assessment;
    result = await provider.assessDamage({
      photos: [{ bytes, mimeType }],
      baseline: null,
      itemDescription: "Test item",
      report,
      signal: AbortSignal.timeout(30_000),
    });
  } else {
    const text = args.join(" ") || "Blue vase, box A, fragile, no visible damage";
    console.log(`Model: ${model}\nCommand: "${text}"\n`);
    result = await provider.interpret({
      text,
      context: "Box labels in this move: A, B.\nActive box: A. Recent items in it: (empty).",
      signal: AbortSignal.timeout(30_000),
    });
  }
  console.log(`Answered in ${Date.now() - started} ms`);

  if (result.kind !== "ok") {
    console.log(`Result: ${result.kind} - ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  const parsed = schema.safeParse(result.raw);
  console.log("Answer:", JSON.stringify(result.raw, null, 2));
  console.log(parsed.success ? "Schema check: OK" : `Schema check: FAILED\n${parsed.error.message}`);
  if (result.usage) {
    const sgd = costMicroSgd(pricingFor(model), 1.35, result.usage) / 1e6;
    console.log(
      `Tokens: input ${result.usage.inputTokens} (audio ${result.usage.audioTokens}), output incl. thinking ${result.usage.outputTokens}`,
    );
    console.log(`Estimated cost: S$${sgd.toFixed(6)} at 1.35 SGD/USD`);
  } else {
    console.log("No usage metadata returned.");
  }
  if (!parsed.success) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
