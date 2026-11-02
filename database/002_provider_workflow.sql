-- TwelveLabs v1.3 workflow: upload an asset, then index it as an indexed asset.
-- provider_task_id holds the indexed-asset ID that is polled while indexing;
-- provider_video_id is set once indexing is ready and is used as the search filter.
ALTER TABLE videos ADD COLUMN provider_asset_id TEXT;
ALTER TABLE videos ADD COLUMN provider_index_id TEXT;
ALTER TABLE videos ADD COLUMN provider_status TEXT;
ALTER TABLE videos ADD COLUMN mime_type TEXT;
ALTER TABLE videos ADD COLUMN status_changed_at TEXT;
ALTER TABLE videos ADD COLUMN indexing_started_at TEXT;

ALTER TABLE indexing_jobs ADD COLUMN lease_owner TEXT;

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

UPDATE videos SET status_changed_at = updated_at WHERE status_changed_at IS NULL;

INSERT OR IGNORE INTO schema_migrations(version) VALUES (2);
