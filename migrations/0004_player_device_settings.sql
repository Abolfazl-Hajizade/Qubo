ALTER TABLE player_game_stats ADD COLUMN base_render_scale REAL;
ALTER TABLE player_game_stats ADD COLUMN current_render_scale REAL;
ALTER TABLE player_game_stats ADD COLUMN adaptive_enabled INTEGER;
ALTER TABLE player_game_stats ADD COLUMN adaptive_change_count INTEGER;
ALTER TABLE player_game_stats ADD COLUMN device_pixel_ratio REAL;
