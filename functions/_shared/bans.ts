export type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
};

export type D1Like = {
  prepare(query: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<T[]>;
};

export async function isBanned(db: D1Like, telegramUserId: string): Promise<boolean> {
  const row = await db.prepare(
    "SELECT telegram_user_id FROM banned_users WHERE telegram_user_id = ?"
  ).bind(telegramUserId).first<{ telegram_user_id: string }>();
  return row !== null;
}

/**
 * D1 batch is atomic. The audit row is inserted before account data is deleted,
 * so the Telegram name and username survive only in the audit record.
 */
export async function banAndDeleteUser(
  db: D1Like,
  telegramUserId: string,
  reason: string,
  deletedBy = "automatic"
): Promise<void> {
  const deletedSections = JSON.stringify([
    "chat_messages",
    "player_checkpoints",
    "leaderboard",
    "player_game_stats",
    "admin_game_stats_seen",
    "telegram_users",
  ]);

  await db.batch([
    db.prepare(`
      INSERT OR IGNORE INTO banned_users (telegram_user_id, reason, banned_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `).bind(telegramUserId, reason.slice(0, 200)),
    db.prepare(`
      INSERT INTO user_deletion_audit (
        telegram_user_id, username, first_name, last_name, display_name,
        reason, deleted_by, deleted_sections, deleted_at
      )
      SELECT
        ?, t.username, t.first_name, t.last_name,
        COALESCE(l.display_name, s.display_name),
        ?, ?, ?, CURRENT_TIMESTAMP
      FROM (SELECT 1) AS seed
      LEFT JOIN telegram_users t ON t.telegram_user_id = ?
      LEFT JOIN leaderboard l ON l.telegram_user_id = ?
      LEFT JOIN player_game_stats s ON s.telegram_user_id = ?
    `).bind(
      telegramUserId,
      reason.slice(0, 200),
      deletedBy.slice(0, 40),
      deletedSections,
      telegramUserId,
      telegramUserId,
      telegramUserId
    ),
    db.prepare("DELETE FROM chat_messages WHERE telegram_user_id = ?").bind(telegramUserId),
    db.prepare("DELETE FROM player_checkpoints WHERE telegram_user_id = ?").bind(telegramUserId),
    db.prepare("DELETE FROM leaderboard WHERE telegram_user_id = ?").bind(telegramUserId),
    db.prepare("DELETE FROM player_game_stats WHERE telegram_user_id = ?").bind(telegramUserId),
    db.prepare("DELETE FROM admin_game_stats_seen WHERE telegram_user_id = ?").bind(telegramUserId),
    db.prepare("DELETE FROM telegram_users WHERE telegram_user_id = ?").bind(telegramUserId),
  ]);
}
