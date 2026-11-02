PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  original_name TEXT NOT NULL,
  storage_name TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  duration_seconds REAL CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  status TEXT NOT NULL CHECK (status IN ('uploading', 'queued', 'indexing', 'ready', 'failed')),
  provider_video_id TEXT,
  provider_task_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS videos_status_idx ON videos(status);

CREATE TABLE IF NOT EXISTS indexing_jobs (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL UNIQUE REFERENCES videos(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
