CREATE TABLE IF NOT EXISTS user_deletion_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  display_name TEXT,
  reason TEXT NOT NULL,
  deleted_by TEXT NOT NULL DEFAULT 'automatic',
  deleted_sections TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_deletion_audit_user
  ON user_deletion_audit (telegram_user_id, deleted_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_deletion_audit_deleted_at
  ON user_deletion_audit (deleted_at DESC);
