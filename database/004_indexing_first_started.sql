-- A retry gives a still-running indexing job a fresh timeout window; the original start is kept here.
ALTER TABLE videos ADD COLUMN indexing_first_started_at TEXT;

INSERT OR IGNORE INTO schema_migrations(version) VALUES (4);
