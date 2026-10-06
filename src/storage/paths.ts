import path from "node:path";

/** Where data lives. Shared by the app and the maintenance scripts. */
export const DATA_DIR = process.env.SAYPACK_DATA_DIR ?? path.join(process.cwd(), "data");
export const DB_PATH = process.env.SAYPACK_DB ?? path.join(DATA_DIR, "saypack.db");
export const PHOTO_ROOT = process.env.SAYPACK_PHOTOS ?? path.join(DATA_DIR, "photos");
export const BACKUP_DIR = process.env.SAYPACK_BACKUP_DIR ?? path.join(process.cwd(), "backups");
