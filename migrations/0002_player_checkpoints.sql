CREATE TABLE IF NOT EXISTS player_checkpoints (
  telegram_user_id TEXT PRIMARY KEY,
  checkpoint INTEGER NOT NULL DEFAULT 0
    CHECK (checkpoint >= 0 AND checkpoint <= 100000 AND checkpoint % 30 = 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
