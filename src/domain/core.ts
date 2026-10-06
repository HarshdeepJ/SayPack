import crypto from "node:crypto";
import type { Db } from "@/db/database";

/** What the domain needs to know about stored photo files. */
export interface PhotoFiles {
  /** True when the committed file for this storage key is present on disk. */
  exists(storageKey: string): boolean;
}

/** Dependencies every application service receives. Swappable in tests. */
export interface Ctx {
  db: Db;
  photos: PhotoFiles;
  now: () => string;
  newId: () => string;
}

export function systemCtx(db: Db, photos: PhotoFiles): Ctx {
  return {
    db,
    photos,
    now: () => new Date().toISOString(),
    newId: () => crypto.randomUUID(),
  };
}

export interface Actor {
  id: string;
  displayName: string;
  isAdmin: boolean;
}

export type DomainErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid";

/** Expected business outcome other than "committed". Route handlers map code to HTTP status. */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    readonly reason: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const forbidden = (message = "You do not have permission for this action.") =>
  new DomainError("forbidden", "forbidden", message);

export const notFound = (what: string) =>
  new DomainError("not_found", "not_found", `${what} was not found.`);

export const invalid = (reason: string, message: string) =>
  new DomainError("invalid", reason, message);

/** Stale expected revision: return the current record so the client can review it. */
export const staleRevision = (current: unknown) =>
  new DomainError(
    "conflict",
    "stale_revision",
    "This record was changed by someone else. Review the current version and try again.",
    { current },
  );

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** JSON with object keys sorted, so equal payloads always hash equally. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
