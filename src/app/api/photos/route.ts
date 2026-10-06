import crypto from "node:crypto";
import { z } from "zod";
import { invalid } from "@/domain/core";
import {
  MAX_PHOTO_BYTES,
  attachPhoto,
  precheckPhoto,
  sniffImageType,
  type PhotoTarget,
} from "@/domain/evidence";
import { photoStore } from "@/server/app";
import { actionId, id, route } from "@/server/http";
import { PhotoStore, sha256Hex } from "@/storage/photo-store";

const Fields = z.object({
  actionId,
  kind: z.enum(["baseline", "incident"]),
  itemId: id.optional(),
  incidentId: id.optional(),
  evidenceRequestId: id.optional(),
});

/**
 * Multipart upload: fields above plus "file".
 * Order: authorize and check for a replay, write the file (staged, then moved
 * into place), then commit the row. Only committed photos are ever served.
 */
export const POST = route("photo.upload", async ({ request, ctx, actor, note }) => {
  const form = await request.formData();
  const fields = Fields.parse({
    actionId: form.get("actionId"),
    kind: form.get("kind"),
    itemId: form.get("itemId") || undefined,
    incidentId: form.get("incidentId") || undefined,
    evidenceRequestId: form.get("evidenceRequestId") || undefined,
  });
  note({ actionId: fields.actionId });

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) throw invalid("missing_file", "Choose a photo to upload.");
  if (file.size > MAX_PHOTO_BYTES) {
    throw invalid("file_too_large", `Photos must be ${MAX_PHOTO_BYTES / 1024 / 1024} MB or smaller.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mediaType = sniffImageType(bytes);
  if (!mediaType) throw invalid("unsupported_type", "Upload a JPEG, PNG or WebP photo.");
  const sha256 = sha256Hex(bytes);

  const target: PhotoTarget = {
    kind: fields.kind,
    itemId: fields.itemId,
    incidentId: fields.incidentId,
    evidenceRequestId: fields.evidenceRequestId,
  };
  const replay = precheckPhoto(ctx, actor, fields.actionId, target, sha256);
  if (replay) return replay;

  const moveId = moveIdFor(ctx, target);
  note({ moveId });
  const photoId = crypto.randomUUID();
  const storageKey = PhotoStore.keyFor(moveId, photoId, mediaType);
  const store = photoStore();
  await store.put(storageKey, bytes);
  try {
    const { photo, replayed } = attachPhoto(ctx, actor, fields.actionId, target, {
      photoId,
      storageKey,
      mediaType,
      sizeBytes: bytes.byteLength,
      sha256,
    });
    if (replayed) await store.remove(storageKey);
    return photo;
  } catch (error) {
    await store.remove(storageKey);
    throw error;
  }
});

function moveIdFor(ctx: Parameters<typeof precheckPhoto>[0], target: PhotoTarget): string {
  const { db } = ctx;
  const row =
    target.kind === "baseline"
      ? db.get(db.q.selectFrom("items").select("move_id").where("id", "=", target.itemId!))
      : db.get(db.q.selectFrom("damage_incidents").select("move_id").where("id", "=", target.incidentId!));
  // precheckPhoto has already confirmed the target exists and is accessible.
  return row!.move_id;
}
