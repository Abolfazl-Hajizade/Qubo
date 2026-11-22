import { banAndDeleteUser, isBanned, type D1Like } from "../_shared/bans";

type Env = { BOT_TOKEN?: string; DB: D1Like };

type TelegramUser = { id: number; first_name?: string; last_name?: string; username?: string };
type AuthenticatedUser = { id: string; displayName: string; username: string | null; firstName: string | null; lastName: string | null };
type ChatRow = { id: number; display_name: string; message: string; created_at: string; is_own: number };
const encoder = new TextEncoder();
const MIN_SCORE = 35;
const ADMIN_ID = "7431567147";

const MAX_MESSAGE_LENGTH = 500;

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
async function readBody(request: Request): Promise<{ initData?: unknown; message?: unknown; action?: unknown; sessionId?: unknown } | null> {
  try { return await request.json() as { initData?: unknown; message?: unknown; action?: unknown; sessionId?: unknown }; }
  catch { return null; }
}
let chatPresenceSchemaReady: Promise<void> | null = null;
async function ensureChatPresenceTable(env: Env): Promise<void> {
  if (!chatPresenceSchemaReady) {
    chatPresenceSchemaReady = (async () => {
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS chat_presence (
          telegram_user_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          last_seen INTEGER NOT NULL,
          PRIMARY KEY (telegram_user_id, session_id)
        )
      `).run();
      await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_chat_presence_last_seen ON chat_presence(last_seen)").run();
    })().catch((error) => {
      chatPresenceSchemaReady = null;
      throw error;
    });
  }
  await chatPresenceSchemaReady;
}
async function getOnlineChatUsers(env: Env): Promise<Array<{ telegram_user_id: string; display_name: string }>> {
  const cutoff = Math.floor(Date.now() / 1000) - 90;
  await env.DB.prepare("DELETE FROM chat_presence WHERE last_seen < ?").bind(cutoff).run();
  const rows = await env.DB.prepare(`
    SELECT telegram_user_id, MAX(display_name) AS display_name
    FROM chat_presence
    WHERE last_seen >= ?
    GROUP BY telegram_user_id
    ORDER BY display_name COLLATE NOCASE
  `).bind(cutoff).all<{ telegram_user_id: string; display_name: string }>();
  return rows.results ?? [];
}
async function getUser(request: Request, env: Env): Promise<AuthenticatedUser | null> {
  if (!env.BOT_TOKEN) return null;
  const initData = request.method === "POST"
    ? String((await request.clone().json().catch(() => ({})) as { initData?: unknown }).initData ?? "")
    : request.headers.get("x-telegram-init-data") ?? "";
  return authenticate(initData, env.BOT_TOKEN);
}
async function checkEligibility(user: AuthenticatedUser, env: Env): Promise<{ bestScore: number; eligible: boolean }> {
  const row = await env.DB.prepare(
    "SELECT best_score FROM leaderboard WHERE telegram_user_id = ?"
  ).bind(user.id).first<{ best_score: number }>();
  const bestScore = row?.best_score ?? 0;
  return { bestScore, eligible: bestScore >= MIN_SCORE };
}

export async function onRequestGet({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!env.BOT_TOKEN || !env.DB) return json({ error: "Chat is not configured" }, 500);
  const user = await getUser(request, env);
  if (!user) return json({ error: "اعتبار تلگرام تأیید نشد." }, 401);
  if (await isBanned(env.DB, user.id)) return json({ banned: true, error: "این حساب از بازی مسدود شده است." }, 403);
  const url = new URL(request.url);
  if (url.searchParams.has("unread_after")) {
    const rawSince = url.searchParams.get("unread_after") ?? "0";
    if (!/^\d+$/.test(rawSince) || !Number.isSafeInteger(Number(rawSince))) {
      return json({ error: "شناسه پیام نامعتبر است." }, 400);
    }
    const since = Number(rawSince);
    const unread = await env.DB.prepare(`
      SELECT COALESCE(MAX(id), 0) AS latest_id,
        COALESCE(SUM(CASE WHEN id > ? AND telegram_user_id <> ? THEN 1 ELSE 0 END), 0) AS unread_count
      FROM chat_messages
    `).bind(since, user.id).first<{ latest_id: number; unread_count: number }>();
    return json({
      eligible: true,
      latest_id: unread?.latest_id ?? 0,
      unread_count: unread?.unread_count ?? 0,
    });
  }

  await saveTelegramUser(env, user);
  const access = await checkEligibility(user, env);
  if (!access.eligible) {
    return json({
      eligible: false,
      best_score: access.bestScore,
      required_score: MIN_SCORE,
      error: "برای مشاهده و ارسال پیام در چت جهانی، امتیاز شما باید حداقل ۳۵ باشد.",
    }, 403);
  }

  await ensureChatPresenceTable(env);
  const [rows, onlineUsers] = await Promise.all([
    env.DB.prepare(`
      SELECT id, display_name, message, created_at,
        CASE WHEN telegram_user_id = ? THEN 1 ELSE 0 END AS is_own
      FROM chat_messages
      ORDER BY id DESC
      LIMIT 100
    `).bind(user.id).all<ChatRow>(),
    getOnlineChatUsers(env),
  ]);
  return json({
    hidden: false,
    eligible: access.eligible,
    best_score: access.bestScore,
    required_score: MIN_SCORE,
    messages: (rows.results ?? []).reverse(),
    online_users: onlineUsers,
  });
}

export async function onRequestPost({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!env.BOT_TOKEN || !env.DB) return json({ error: "Chat is not configured" }, 500);
  const body = await readBody(request);
  if (!body) return json({ error: "Invalid JSON" }, 400);
  const user = await authenticate(String(body.initData ?? ""), env.BOT_TOKEN);
  if (!user) return json({ error: "اعتبار تلگرام تأیید نشد." }, 401);
  if (await isBanned(env.DB, user.id)) return json({ banned: true, error: "این حساب از بازی مسدود شده است." }, 403);
  const access = await checkEligibility(user, env);
  if (!access.eligible) {
    await banAndDeleteUser(env.DB, user.id, "Attempted to send a global chat message with a score below 35");
    return json({ banned: true, error: "به دلیل تلاش برای ارسال پیام در چت با امتیاز کمتر از ۳۵، حساب شما مسدود شد." }, 403);
  }
  await saveTelegramUser(env, user);
  if (body.action === "presence_enter" || body.action === "presence_heartbeat" || body.action === "presence_leave") {
    const sessionId = String(body.sessionId ?? "");
    if (!/^[a-f0-9-]{16,64}$/i.test(sessionId)) return json({ error: "شناسه نشست نامعتبر است." }, 400);
    await ensureChatPresenceTable(env);
    if (body.action === "presence_leave") {
      await env.DB.prepare("DELETE FROM chat_presence WHERE telegram_user_id = ? AND session_id = ?")
        .bind(user.id, sessionId).run();
      return json({ ok: true, online_users: await getOnlineChatUsers(env) });
    }
    await env.DB.prepare(`
      INSERT INTO chat_presence (telegram_user_id, session_id, display_name, last_seen)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(telegram_user_id, session_id) DO UPDATE SET
        display_name = excluded.display_name,
        last_seen = excluded.last_seen
    `).bind(user.id, sessionId, user.displayName, Math.floor(Date.now() / 1000)).run();
    return json({ ok: true });
  }
  if (typeof body.message !== "string") return json({ error: "متن پیام نامعتبر است." }, 400);
  const message = body.message.trim();
  if (!message || message.length > MAX_MESSAGE_LENGTH) return json({ error: "پیام باید بین ۱ تا ۵۰۰ کاراکتر باشد." }, 400);

  const recent = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM chat_messages
    WHERE telegram_user_id = ? AND created_at >= datetime('now', '-2 seconds')
  `).bind(user.id).first<{ count: number }>();
  if ((recent?.count ?? 0) > 0) return json({ error: "برای ارسال پیام بعدی کمی صبر کن." }, 429);

  await env.DB.prepare(`
    INSERT INTO chat_messages (telegram_user_id, display_name, message)
    VALUES (?, ?, ?)
  `).bind(user.id, user.displayName, message).run();
  await env.DB.prepare(`
    DELETE FROM chat_messages
    WHERE id NOT IN (SELECT id FROM chat_messages ORDER BY id DESC LIMIT 100)
  `).bind().run();
  return json({ ok: true });
}


export async function onRequestDelete({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!env.BOT_TOKEN || !env.DB) return json({ error: "Chat is not configured" }, 500);
  const user = await getUser(request, env);
  if (!user) return json({ error: "اعتبار تلگرام تأیید نشد." }, 401);
  if (await isBanned(env.DB, user.id)) return json({ banned: true, error: "این حساب از بازی مسدود شده است." }, 403);
  await saveTelegramUser(env, user);
  if (user.id !== ADMIN_ID) return json({ error: "Forbidden" }, 403);
  const rawId = new URL(request.url).searchParams.get("id");
  if (!rawId || !/^\d+$/.test(rawId) || !Number.isSafeInteger(Number(rawId)) || Number(rawId) <= 0) {
    return json({ error: "شناسه پیام نامعتبر است." }, 400);
  }
  const result = await env.DB.prepare("DELETE FROM chat_messages WHERE id = ?")
    .bind(Number(rawId)).run();
  return json({ ok: true });
}
