import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PhotoFiles } from "@/domain/core";
import type { PhotoMediaType } from "@/domain/evidence";

const EXTENSIONS: Record<PhotoMediaType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const STAGING = ".staging";
const KEY_PATTERN = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

/**
 * Private photo files under one root directory, outside the public web folder.
 * Storage keys are generated "<moveId>/<photoId>.<ext>"; nothing user-supplied reaches a path.
 *
 * Writes go to a staging file first, are fsynced, then renamed into place.
 * The database row is committed after that, so a crash can leave an orphan file
 * (cleaned up by sweepOrphans) but never a committed row without its file.
 */
export class PhotoStore implements PhotoFiles {
  constructor(readonly root: string) {}

  static keyFor(moveId: string, photoId: string, mediaType: PhotoMediaType) {
    return `${moveId}/${photoId}.${EXTENSIONS[mediaType]}`;
  }

  /** Resolves a key to an absolute path, refusing anything that is not a generated key. */
  pathFor(storageKey: string): string {
    if (!KEY_PATTERN.test(storageKey)) throw new Error(`Invalid storage key: ${storageKey}`);
    return path.join(this.root, ...storageKey.split("/"));
  }

  exists(storageKey: string): boolean {
    try {
      return fs.statSync(this.pathFor(storageKey)).isFile();
    } catch {
      return false;
    }
  }

  /** Writes bytes to staging, then moves them to the key's final location. */
  async put(storageKey: string, bytes: Uint8Array): Promise<void> {
    const finalPath = this.pathFor(storageKey);
    const stagingDir = path.join(this.root, STAGING);
    await fs.promises.mkdir(stagingDir, { recursive: true });
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    const stagingPath = path.join(stagingDir, `${crypto.randomUUID()}.part`);
    const handle = await fs.promises.open(stagingPath, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(stagingPath, finalPath);
  }

  async read(storageKey: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.promises.readFile(this.pathFor(storageKey)));
  }

  async remove(storageKey: string): Promise<void> {
    await fs.promises.rm(this.pathFor(storageKey), { force: true });
  }

  /**
   * Deletes staging leftovers and final files with no committed row, once older than the
   * grace period (so an upload between file write and commit is not removed).
   */
  async sweepOrphans(committedKeys: Set<string>, graceMs = 60 * 60 * 1000): Promise<string[]> {
    const removed: string[] = [];
    const cutoff = Date.now() - graceMs;
    if (!fs.existsSync(this.root)) return removed;
    for (const entry of await fs.promises.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.root, entry.name);
      for (const file of await fs.promises.readdir(dir)) {
        const full = path.join(dir, file);
        const stat = await fs.promises.stat(full);
        if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
        const key = `${entry.name}/${file}`;
        if (entry.name === STAGING || !committedKeys.has(key)) {
          await fs.promises.rm(full, { force: true });
          removed.push(key);
        }
      }
    }
    return removed;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
