-- The stored index may now be adopted from the account, not only created by the app.
UPDATE app_settings SET key = 'twelvelabs.index_id'
WHERE key = 'twelvelabs.created_index_id'
  AND NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'twelvelabs.index_id');

INSERT OR IGNORE INTO schema_migrations(version) VALUES (3);
