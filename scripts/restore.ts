// Restores a backup made by `npm run backup`. Stop the app first.
//   npm run restore -- backups/<timestamp>
// The current database and photos are moved aside to data/pre-restore-<timestamp>/, not deleted.
import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { openDatabase } from "@/db/database";
import { DATA_DIR, DB_PATH, PHOTO_ROOT } from "@/storage/paths";
import { PhotoStore, sha256Hex } from "@/storage/photo-store";
import type { BackupManifest } from "./backup";

/**
 * Switching out of WAL mode needs every other connection closed, so it doubles as a
 * check that the app is stopped. It also folds the WAL into the main file, so the
 * database is a single file when it is moved aside.
 */
function assertNotInUse(dbPath: string) {
  if (!fs.existsSync(dbPath)) return;
  const inUse = new Error("The database is in use. Stop the app (npm start) and try again.");
  const db = new BetterSqlite3(dbPath, { timeout: 1000 });
  try {
    const mode = db.pragma("journal_mode = DELETE", { simple: true });
    if (mode !== "delete") throw inUse;
  } catch (error) {
    throw error === inUse ? inUse : Object.assign(inUse, { cause: error });
  } finally {
    db.close();
  }
}

function main() {
  const source = process.argv[2];
  if (!source) {
    console.error("Usage: npm run restore -- backups/<timestamp>");
    process.exit(1);
  }
  const manifestPath = path.join(source, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`No manifest.json in ${source}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BackupManifest;
  const backupDb = path.join(source, manifest.database);

  // Verify the backup completely before touching live data.
  const check = new BetterSqlite3(backupDb, { readonly: true, fileMustExist: true });
  const integrity = check.pragma("integrity_check", { simple: true });
  check.close();
  if (integrity !== "ok") throw new Error(`Backup database failed its integrity check: ${integrity}`);
  const backupPhotos = new PhotoStore(path.join(source, "photos"));
  const missing = new Set(manifest.missingPhotos);
  for (const photo of manifest.photos) {
    if (missing.has(photo.storageKey)) continue;
    const file = backupPhotos.pathFor(photo.storageKey);
    if (!fs.existsSync(file) || sha256Hex(fs.readFileSync(file)) !== photo.sha256) {
      throw new Error(`Backup photo is missing or corrupt: ${photo.storageKey}`);
    }
  }

  assertNotInUse(DB_PATH);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const aside = path.join(DATA_DIR, `pre-restore-${stamp}`);
  fs.mkdirSync(aside, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(DB_PATH + suffix)) fs.renameSync(DB_PATH + suffix, path.join(aside, path.basename(DB_PATH) + suffix));
  }
  if (fs.existsSync(PHOTO_ROOT)) fs.renameSync(PHOTO_ROOT, path.join(aside, "photos"));

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.copyFileSync(backupDb, DB_PATH);
  const livePhotos = new PhotoStore(PHOTO_ROOT);
  for (const photo of manifest.photos) {
    if (missing.has(photo.storageKey)) continue;
    const to = livePhotos.pathFor(photo.storageKey);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(backupPhotos.pathFor(photo.storageKey), to);
  }

  // Opening applies any migrations newer than the backup.
  const restored = openDatabase(DB_PATH);
  const users = (restored.raw.prepare("SELECT count(*) AS n FROM users").get() as { n: number }).n;
  restored.close();

  console.log(`Restored ${source} (taken ${manifest.createdAt}).`);
  console.log(`  users: ${users}, photos: ${manifest.photos.length - missing.size}`);
  console.log(`  Previous data moved to ${aside}`);
  if (missing.size) console.warn(`  ${missing.size} photo(s) were already missing when the backup was taken.`);
  console.log("Check notification jobs before resuming normal use, then start the app.");
}

try {
  main();
} catch (error) {
  console.error(`Restore failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
