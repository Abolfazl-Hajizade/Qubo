import { isBanned, type D1Like } from "../_shared/bans";

type Env = { BOT_TOKEN?: string; DB: D1Like };

type TelegramUser = { id: number; first_name?: string; last_name?: string; username?: string };
type AuthenticatedUser = { id: string; displayName: string; username: string | null; firstName: string | null; lastName: string | null };
type GameStat = {
  telegram_user_id: string;
  display_name: string;
  game_count: number;
  previous_game_count: number | null;
};
const encoder = new TextEncoder();
const ADMIN_ID = "7431567147";

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmac(keyBytes: Uint8Array, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, encoder.encode(message));
}
async function authenticate(initData: string, botToken: string): Promise<AuthenticatedUser | null> {
  if (!initData || initData.length > 10_000) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  const authDateValue = params.get("auth_date");
  const userValue = params.get("user");
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash) || !authDateValue || !userValue) return null;
  const authDate = Number(authDateValue);
  if (!Number.isFinite(authDate) || authDate > Date.now() / 1000 + 60 || Date.now() / 1000 - authDate > 86_400) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = new Uint8Array(await hmac(encoder.encode("WebAppData"), botToken));
  const expectedHash = hex(await hmac(secret, dataCheckString));
  if (expectedHash.length !== receivedHash.length) return null;
  let mismatch = 0;
  for (let i = 0; i < expectedHash.length; i++) mismatch |= expectedHash.charCodeAt(i) ^ receivedHash.toLowerCase().charCodeAt(i);
  if (mismatch !== 0) return null;
  try {
    const user = JSON.parse(userValue) as TelegramUser;
    if (!Number.isSafeInteger(user.id) || user.id <= 0) return null;
    const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim()
      || (user.username ? `@${user.username}` : `Player ${user.id}`);
    return { id: String(user.id), displayName: displayName.slice(0, 80), username: user.username ?? null, firstName: user.first_name ?? null, lastName: user.last_name ?? null };
  } catch { return null; }
}
async function saveTelegramUser(env: Env, user: AuthenticatedUser): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO telegram_users (telegram_user_id, username, first_name, last_name, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      username = COALESCE(excluded.username, telegram_users.username),
      first_name = COALESCE(excluded.first_name, telegram_users.first_name),
      last_name = COALESCE(excluded.last_name, telegram_users.last_name),
      updated_at = CURRENT_TIMESTAMP
  `).bind(user.id, user.username, user.firstName, user.lastName).run();
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function onRequestPost({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!env.BOT_TOKEN || !env.DB) return json({ error: "Game statistics are not configured" }, 500);
  let body: { initData?: unknown };
  try { body = await request.json() as { initData?: unknown }; }
  catch { return json({ error: "Invalid JSON" }, 400); }
  const user = await authenticate(String(body.initData ?? ""), env.BOT_TOKEN);
  if (!user) return json({ error: "اعتبار تلگرام تأیید نشد." }, 401);
  if (await isBanned(env.DB, user.id)) return json({ banned: true, error: "این حساب از بازی مسدود شده است." }, 403);
  await saveTelegramUser(env, user);

  await env.DB.prepare(`
    INSERT INTO player_game_stats (telegram_user_id, display_name, game_count, updated_at)
    VALUES (?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      display_name = excluded.display_name,
      game_count = player_game_stats.game_count + 1,
      updated_at = CURRENT_TIMESTAMP
  `).bind(user.id, user.displayName).run();

  return json({ ok: true });
}

export async function onRequestGet({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!env.BOT_TOKEN || !env.DB) return json({ error: "Game statistics are not configured" }, 500);
  const user = await authenticate(request.headers.get("x-telegram-init-data") ?? "", env.BOT_TOKEN);
  if (!user) return json({ error: "اعتبار تلگرام تأیید نشد." }, 401);
  if (await isBanned(env.DB, user.id)) return json({ banned: true, error: "این حساب از بازی مسدود شده است." }, 403);
  const isAdmin = user.id === ADMIN_ID;
  if (!isAdmin) return json({ error: "Forbidden" }, 403);
  await saveTelegramUser(env, user);
  const rows = await env.DB.prepare(`
    SELECT
      stats.telegram_user_id,
      stats.display_name,
      stats.game_count,
      seen.game_count AS previous_game_count
    FROM player_game_stats AS stats
    LEFT JOIN admin_game_stats_seen AS seen
      ON seen.telegram_user_id = stats.telegram_user_id
    ORDER BY stats.game_count DESC, stats.display_name COLLATE NOCASE ASC
  `).bind().all<GameStat>();

  const players = rows.results.map((row) => ({
    telegram_user_id: row.telegram_user_id,
    display_name: row.display_name,
    game_count: Number(row.game_count),
    increased: isAdmin && row.previous_game_count !== null
      && Number(row.game_count) > Number(row.previous_game_count),
  }));

  // Only the admin may acknowledge count changes; eligible regular players always see red.
  if (isAdmin) {
    for (const player of players) {
      await env.DB.prepare(`
        INSERT INTO admin_game_stats_seen (telegram_user_id, game_count, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(telegram_user_id) DO UPDATE SET
          game_count = excluded.game_count,
          updated_at = CURRENT_TIMESTAMP
      `).bind(player.telegram_user_id, player.game_count).run();
    }
  }

  return json({ players, isAdmin });
}
