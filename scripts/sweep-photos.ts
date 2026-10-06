// Removes photo files that no committed database row references (left by a crash
// between writing a file and committing its row), once older than one hour.
//   npm run sweep-photos
import { openDatabase } from "@/db/database";
import { systemCtx } from "@/domain/core";
import { committedStorageKeys } from "@/domain/evidence";
import { DB_PATH, PHOTO_ROOT } from "@/storage/paths";
import { PhotoStore } from "@/storage/photo-store";

async function main() {
  const store = new PhotoStore(PHOTO_ROOT);
  const db = openDatabase(DB_PATH);
  try {
    const removed = await store.sweepOrphans(committedStorageKeys(systemCtx(db, store)));
    console.log(removed.length ? `Removed ${removed.length} orphaned file(s):\n  ${removed.join("\n  ")}` : "No orphaned photo files.");
  } finally {
    db.close();
  }
}

void main();
