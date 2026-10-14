import { z } from "zod";
import { MAX_AUDIO_SECONDS } from "@/domain/ai";
import { invalid } from "@/domain/core";
import { requireMovePermission } from "@/domain/moves";
import { aiStatus, submitVoice } from "@/domain/voice";
import { aiProvider } from "@/server/app";
import { actionId, id, route } from "@/server/http";

const MAX_AUDIO_BYTES = 1024 * 1024;

/** Real container type from the first bytes; Android Chrome records WebM/Opus. */
function sniffAudio(bytes: Uint8Array): string | null {
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "audio/webm";
  }
  if (bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === "OggS") return "audio/ogg";
  return null;
}

export const GET = route<{ moveId: string }>("voice.status", ({ ctx, actor, params }) => {
  requireMovePermission(ctx, actor, params.moveId, "inventory.read");
  return aiStatus(ctx, aiProvider());
});

const Fields = z.object({
  actionId,
  boxId: id.optional(),
  clarifiesRequestId: id.optional(),
  text: z.string().max(300).optional(),
  seconds: z.coerce.number().positive().max(MAX_AUDIO_SECONDS + 1).optional(),
});

/** Multipart: actionId, optional boxId and clarifiesRequestId, and either "text" or "audio" + "seconds". */
export const POST = route<{ moveId: string }>("voice.submit", async ({ request, ctx, actor, params, note }) => {
  const form = await request.formData();
  const fields = Fields.parse({
    actionId: form.get("actionId"),
    boxId: form.get("boxId") || undefined,
    clarifiesRequestId: form.get("clarifiesRequestId") || undefined,
    text: form.get("text") || undefined,
    seconds: form.get("seconds") || undefined,
  });
  note({ actionId: fields.actionId });

  let audio: { bytes: Uint8Array; mimeType: string; seconds: number } | undefined;
  const file = form.get("audio");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_AUDIO_BYTES) throw invalid("audio_too_large", "That recording is too large. Keep commands short.");
    if (!fields.seconds) throw invalid("missing_duration", "The recording's length is missing.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mimeType = sniffAudio(bytes);
    if (!mimeType) throw invalid("unsupported_audio", "Unsupported recording format.");
    audio = { bytes, mimeType, seconds: fields.seconds };
  }

  return submitVoice(ctx, aiProvider(), actor, {
    moveId: params.moveId,
    actionId: fields.actionId,
    context: { boxId: fields.boxId ?? null },
    clarifiesRequestId: fields.clarifiesRequestId,
    audio,
    text: audio ? undefined : fields.text,
  });
});
