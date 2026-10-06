import "server-only";
import path from "node:path";
import { openDatabase, type Db } from "@/db/database";
import { systemCtx, type Ctx } from "@/domain/core";

export const DB_PATH = process.env.SAYPACK_DB ?? path.join(process.cwd(), "data", "saypack.db");

// One connection per process; kept on globalThis so dev hot reloads don't open more.
const globalForDb = globalThis as unknown as { saypackDb?: Db };

export function appCtx(): Ctx {
  globalForDb.saypackDb ??= openDatabase(DB_PATH);
  return systemCtx(globalForDb.saypackDb);
}
