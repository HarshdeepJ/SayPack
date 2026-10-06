import fs from "node:fs";
import { photoForDownload } from "@/domain/evidence";
import { photoStore } from "@/server/app";
import { route } from "@/server/http";

/** Serves a photo to move members only. Storage paths never leave the server. */
export const GET = route<{ photoId: string }>("photo.download", async ({ ctx, actor, params }) => {
  const { storageKey, mediaType } = photoForDownload(ctx, actor, params.photoId);
  const bytes = await fs.promises.readFile(photoStore().pathFor(storageKey));
  return new Response(bytes, {
    headers: {
      "content-type": mediaType,
      "content-length": String(bytes.byteLength),
      "cache-control": "private, max-age=86400, immutable",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
});
