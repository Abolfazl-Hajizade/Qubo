CREATE TABLE IF NOT EXISTS player_game_stats (
  telegram_user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  game_count INTEGER NOT NULL DEFAULT 0 CHECK (game_count >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
