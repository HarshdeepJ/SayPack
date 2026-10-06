import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import {
  Kysely,
  DummyDriver,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type Compilable,
} from "kysely";
import type { Schema } from "./schema";

/**
 * Kysely builds typed SQL; better-sqlite3 executes it synchronously.
 * A transaction is a plain synchronous function, so it cannot await a network
 * call midway — better-sqlite3 throws if a transaction function returns a promise.
 */
const builder = new Kysely<Schema>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

export type QueryBuilder = Kysely<Schema>;

export class Db {
  readonly q: QueryBuilder = builder;

  constructor(readonly raw: BetterSqlite3.Database) {}

  all<R>(query: Compilable<R>): R[] {
    const { sql, parameters } = query.compile();
    return this.raw.prepare(sql).all(...(parameters as unknown[])) as R[];
  }

  get<R>(query: Compilable<R>): R | undefined {
    const { sql, parameters } = query.compile();
    return this.raw.prepare(sql).get(...(parameters as unknown[])) as R | undefined;
  }

  run(query: Compilable<unknown>): BetterSqlite3.RunResult {
    const { sql, parameters } = query.compile();
    return this.raw.prepare(sql).run(...(parameters as unknown[]));
  }

  /** Runs fn in an immediate (write-locking) transaction. fn must be synchronous. */
  transaction<T>(fn: () => T): T {
    return this.raw.transaction(fn).immediate();
  }

  close() {
    this.raw.close();
  }
}

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

export function openDatabase(filename: string, migrationsDir = MIGRATIONS_DIR): Db {
  if (filename !== ":memory:") {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  const raw = new BetterSqlite3(filename);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma("busy_timeout = 5000");
  raw.pragma("synchronous = NORMAL");
  migrate(raw, migrationsDir);
  return new Db(raw);
}

function migrate(raw: BetterSqlite3.Database, dir: string) {
  raw.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (raw.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    raw
      .transaction(() => {
        raw.exec(sql);
        raw
          .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
          .run(file, new Date().toISOString());
      })
      .immediate();
  }
}
