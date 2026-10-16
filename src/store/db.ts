import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { FACTORY_ROOT } from "../paths.js";

export type Db = Database.Database;

export const MIGRATIONS_DIR = path.join(FACTORY_ROOT, "migrations");
/** Default database file (git-ignored). Override with FACTORY_DB. */
export const DEFAULT_DB_PATH = path.join(FACTORY_ROOT, "data", "factory.db");

const MIGRATION_FILE = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => {
      const m = MIGRATION_FILE.exec(file);
      if (!m?.[1] || !m[2])
        throw new Error(`Bad migration file name: ${file} (expected NNN_name.sql)`);
      const sql = readFileSync(path.join(dir, file), "utf8");
      return {
        version: Number(m[1]),
        name: m[2],
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    });
  migrations.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new Error(`Migrations must be numbered 001, 002, … without gaps (got ${m.version})`);
  });
  return migrations;
}

/** First line of a migration that must run with foreign keys off (a table rebuild). */
const FK_OFF_MARKER = "-- factory:foreign_keys=off";

/**
 * Applies pending migrations in order, each in its own transaction, and records them in
 * `schema_migrations`. An already-applied migration whose file changed is an error:
 * applied migrations are immutable, schema changes go into a new file.
 */
export function migrate(db: Db, migrations: readonly Migration[] = loadMigrations()): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Map(
    (
      db.prepare("SELECT version, name, checksum FROM schema_migrations").all() as {
        version: number;
        name: string;
        checksum: string;
      }[]
    ).map((r) => [r.version, r]),
  );
  const newlyApplied: number[] = [];
  for (const m of migrations) {
    const prev = applied.get(m.version);
    if (prev) {
      if (prev.checksum !== m.checksum || prev.name !== m.name) {
        throw new Error(
          `Migration ${String(m.version).padStart(3, "0")}_${m.name} was modified after being applied; add a new migration instead`,
        );
      }
      continue;
    }
    // A table rebuild (SQLite's documented procedure for changing a constraint) needs foreign
    // keys off; the pragma is a no-op inside a transaction, so it is switched around it and
    // integrity is checked before COMMIT.
    const fkOff = m.sql.startsWith(FK_OFF_MARKER);
    const fkWasOn = fkOff && db.pragma("foreign_keys", { simple: true }) === 1;
    if (fkWasOn) db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(m.sql);
        if (fkOff) {
          const violations = db.pragma("foreign_key_check") as unknown[];
          if (violations.length > 0) {
            throw new Error(
              `Migration ${m.name} broke foreign keys: ${JSON.stringify(violations.slice(0, 3))}`,
            );
          }
        }
        db.prepare(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        ).run(m.version, m.name, m.checksum, new Date().toISOString());
      })();
    } finally {
      if (fkWasOn) db.pragma("foreign_keys = ON");
    }
    newlyApplied.push(m.version);
  }
  return newlyApplied;
}

/** Opens (creating if needed) and migrates the factory database. */
export function openDb(file: string = process.env["FACTORY_DB"] ?? DEFAULT_DB_PATH): Db {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}
