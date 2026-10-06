import "server-only";
import { openDatabase, type Db } from "@/db/database";
import { systemCtx, type Ctx } from "@/domain/core";
import { PhotoStore } from "@/storage/photo-store";
import { DB_PATH, PHOTO_ROOT } from "@/storage/paths";

// One connection per process; kept on globalThis so dev hot reloads don't open more.
const globalForDb = globalThis as unknown as { saypackDb?: Db; saypackPhotos?: PhotoStore };

export function photoStore(): PhotoStore {
  globalForDb.saypackPhotos ??= new PhotoStore(PHOTO_ROOT);
  return globalForDb.saypackPhotos;
}

export function appCtx(): Ctx {
  if (!globalForDb.saypackDb) {
    globalForDb.saypackDb = openDatabase(DB_PATH);
    closeOnExit(globalForDb.saypackDb);
  }
  return systemCtx(globalForDb.saypackDb, photoStore());
}

/**
 * Closes the database when the process ends, so SQLite folds the WAL file
 * back into the main database file. The WAL is safe either way; this only
 * avoids leaving a large -wal file behind after a normal stop.
 */
function closeOnExit(db: Db) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      db.close();
    } catch {
      // Already closed or mid-shutdown; nothing more to do.
    }
  };
  process.once("exit", close);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      close();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}
