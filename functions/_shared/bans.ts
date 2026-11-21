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

/** D1 batch executes these statements atomically; the ban row intentionally survives account-data deletion. */
export async function banAndDeleteUser(db: D1Like, telegramUserId: string, reason: string): Promise<void> {
  await db.batch([
    db.prepare(`
      INSERT OR IGNORE INTO banned_users (telegram_user_id, reason, banned_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `).bind(telegramUserId, reason.slice(0, 200)),
    db.prepare("DELETE FROM chat_messages WHERE telegram_user_id = ?").bind(telegramUserId),
    db.prepare("DELETE FROM player_checkpoints WHERE telegram_user_id = ?").bind(telegramUserId),
    db.prepare("DELETE FROM leaderboard WHERE telegram_user_id = ?").bind(telegramUserId),
    db.prepare("DELETE FROM player_game_stats WHERE telegram_user_id = ?").bind(telegramUserId),
    db.prepare("DELETE FROM admin_game_stats_seen WHERE telegram_user_id = ?").bind(telegramUserId),
    db.prepare("DELETE FROM telegram_users WHERE telegram_user_id = ?").bind(telegramUserId),
  ]);
}
