// Takes a consistent backup of the database and the photos it references.
//   npm run backup                 -> backups/<timestamp>/
// Safe while the app is running: it uses SQLite's online backup API, then copies
// exactly the photo files the snapshot references and verifies their checksums.
import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { BACKUP_DIR, DB_PATH, PHOTO_ROOT } from "@/storage/paths";
import { PhotoStore, sha256Hex } from "@/storage/photo-store";

export interface BackupManifest {
  format: 1;
  createdAt: string;
  database: string;
  counts: Record<string, number>;
  photos: { storageKey: string; sha256: string; sizeBytes: number }[];
  /** Photos the database references whose files were missing or corrupt at backup time. */
  missingPhotos: string[];
}

async function main() {
  if (!fs.existsSync(DB_PATH)) throw new Error(`No database at ${DB_PATH}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(BACKUP_DIR, stamp);
  fs.mkdirSync(path.join(dir, "photos"), { recursive: true });
  const backupDb = path.join(dir, "saypack.db");

  const live = new BetterSqlite3(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    await live.backup(backupDb);
  } finally {
    live.close();
  }

  // Read the photo list from the snapshot, not the live database, so the two match.
  const snapshot = new BetterSqlite3(backupDb);
  const integrity = snapshot.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") throw new Error(`Backup integrity check failed: ${integrity}`);
  snapshot.pragma("journal_mode = DELETE");
  const tables = ["users", "moves", "boxes", "items", "damage_incidents", "holds", "photos"];
  const counts = Object.fromEntries(
    tables.map((t) => [t, (snapshot.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n]),
  );
  const photos = snapshot
    .prepare("SELECT storage_key AS storageKey, sha256, size_bytes AS sizeBytes FROM photos")
    .all() as BackupManifest["photos"];
  snapshot.close();

  const source = new PhotoStore(PHOTO_ROOT);
  const target = new PhotoStore(path.join(dir, "photos"));
  const missingPhotos: string[] = [];
  for (const photo of photos) {
    const from = source.pathFor(photo.storageKey);
    if (!fs.existsSync(from)) {
      missingPhotos.push(photo.storageKey);
      continue;
    }
    const bytes = fs.readFileSync(from);
    if (sha256Hex(bytes) !== photo.sha256) {
      missingPhotos.push(photo.storageKey);
      continue;
    }
    const to = target.pathFor(photo.storageKey);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, bytes);
  }

  const manifest: BackupManifest = {
    format: 1,
    createdAt: new Date().toISOString(),
    database: "saypack.db",
    counts,
    photos,
    missingPhotos,
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`Backup written to ${dir}`);
  console.log(`  ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  console.log(`  photos copied: ${photos.length - missingPhotos.length} of ${photos.length}`);
  if (missingPhotos.length) {
    console.warn(`  WARNING: ${missingPhotos.length} referenced photo file(s) missing or corrupt; listed in manifest.json`);
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`Backup failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
