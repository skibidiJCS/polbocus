import "server-only";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getServerConfig } from "./config";

export type Db = DatabaseSync;

const globalForDb = globalThis as typeof globalThis & { __footageDb?: { path: string; db: DatabaseSync } };

/** Applies database/NNN_*.sql files that are not yet recorded in schema_migrations. */
export function applyMigrations(db: DatabaseSync, migrationsDir = path.join(/* turbopackIgnore: true */ process.cwd(), "database")) {
  const files = readdirSync(migrationsDir).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  const applied = new Set(hasTable ? db.prepare("SELECT version FROM schema_migrations").all().map((row) => Number(row.version)) : []);
  for (const file of files) {
    const version = Number.parseInt(file, 10);
    if (applied.has(version)) continue;
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }
}

export function openDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  applyMigrations(db);
  return db;
}

/** One connection per server process; survives dev hot reloads. */
export function getDb(): DatabaseSync {
  const config = getServerConfig();
  const dbPath = path.join(config.dataDir, "footage.sqlite");
  if (globalForDb.__footageDb?.path === dbPath) return globalForDb.__footageDb.db;
  mkdirSync(config.videosDir, { recursive: true });
  mkdirSync(config.tmpDir, { recursive: true });
  const db = openDb(dbPath);
  globalForDb.__footageDb = { path: dbPath, db };
  return db;
}

export function nowIso(date = new Date()) {
  return date.toISOString();
}

export function getSetting(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: DatabaseSync, key: string, value: string) {
  db.prepare(
    "INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value, nowIso());
}
