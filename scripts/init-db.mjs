import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

// Node 24's built-in SQLite keeps the baseline free of native addon compilation.
// The server applies the same numbered migrations on startup (src/lib/server/db.ts).
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR || "./data");
const publicDir = path.resolve(process.cwd(), "public");
const relative = path.relative(publicDir, dataDir);
if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
  throw new Error("DATA_DIR must be outside public/.");
}
mkdirSync(path.join(dataDir, "videos"), { recursive: true });
mkdirSync(path.join(dataDir, "tmp"), { recursive: true });
const dbPath = path.join(dataDir, "footage.sqlite");
const db = new DatabaseSync(dbPath);
try {
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const migrationsDir = new URL("../database/", import.meta.url);
  const files = readdirSync(migrationsDir).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  const applied = new Set(hasTable ? db.prepare("SELECT version FROM schema_migrations").all().map((row) => Number(row.version)) : []);
  for (const file of files) {
    const version = Number.parseInt(file, 10);
    if (applied.has(version)) continue;
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(readFileSync(new URL(file, migrationsDir), "utf8"));
      db.exec("COMMIT;");
      console.log(`Applied migration ${file}`);
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }
  console.log(`Database ready: ${dbPath}`);
} finally {
  db.close();
}
