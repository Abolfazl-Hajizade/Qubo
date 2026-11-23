import { isBanned, banAndDeleteUser, type D1Like } from "../_shared/bans";

type Env = { BOT_TOKEN?: string; DB: D1Like };

type TelegramUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type AuthenticatedUser = {
  id: string;
  displayName: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
};

const encoder = new TextEncoder();
const CHECKPOINT_STEP = 30;

function checkpointForScore(score: number): number {
  if (score < 15) return 0;
  if (score < 30) return 15;
  return Math.floor(score / CHECKPOINT_STEP) * CHECKPOINT_STEP;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(keyBytes: Uint8Array, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, encoder.encode(message));
}

async function authenticate(initData: string, botToken: string): Promise<{ user: AuthenticatedUser | null; reason?: string }> {
  if (!initData) return { user: null, reason: "empty_init_data" };
  if (initData.length > 10_000) return { user: null, reason: "init_data_too_large" };

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  const authDateValue = params.get("auth_date");
  const userValue = params.get("user");
  if (!receivedHash) return { user: null, reason: "missing_hash" };
  if (!/^[a-f0-9]{64}$/i.test(receivedHash)) return { user: null, reason: "invalid_hash_format" };
  if (!authDateValue) return { user: null, reason: "missing_auth_date" };
  if (!userValue) return { user: null, reason: "missing_user" };
  const authDate = Number(authDateValue);
  if (!Number.isFinite(authDate)) return { user: null, reason: "invalid_auth_date" };
  if (authDate > Date.now() / 1000 + 60) return { user: null, reason: "auth_date_in_future" };
  if (Date.now() / 1000 - authDate > 86_400) return { user: null, reason: "auth_data_expired" };

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = new Uint8Array(await hmac(encoder.encode("WebAppData"), botToken));
  const expectedHash = hex(await hmac(secret, dataCheckString));
  if (expectedHash.length !== receivedHash.length) return { user: null, reason: "signature_length_mismatch" };
  let mismatch = 0;
  for (let i = 0; i < expectedHash.length; i++) mismatch |= expectedHash.charCodeAt(i) ^ receivedHash.toLowerCase().charCodeAt(i);
  if (mismatch !== 0) return { user: null, reason: "signature_mismatch" };

  try {
    const user = JSON.parse(userValue) as TelegramUser;
    if (!Number.isSafeInteger(user.id) || user.id <= 0) return { user: null, reason: "invalid_user_id" };
    const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim()
      || (user.username ? `@${user.username}` : `Player ${user.id}`);
    return { user: { id: String(user.id), displayName: displayName.slice(0, 80), username: user.username ?? null, firstName: user.first_name ?? null, lastName: user.last_name ?? null } };
  } catch {
    return { user: null, reason: "invalid_user_json" };
  }
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
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function getUser(request: Request, env: Env): Promise<{ user: AuthenticatedUser | null; reason?: string }> {
  if (!env.BOT_TOKEN) return { user: null, reason: "missing_bot_token" };
  const initData = request.method === "POST"
    ? String((await request.clone().json().catch(() => ({})) as { initData?: unknown }).initData ?? "")
    : request.headers.get("x-telegram-init-data") ?? "";
  return authenticate(initData, env.BOT_TOKEN);
}

type LeaderboardRow = {
  telegram_user_id: string;
  display_name: string;
  best_score: number;
  rank: number;
};

export async function onRequestGet({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!env.BOT_TOKEN || !env.DB) return json({ error: "Leaderboard is not configured" }, 500);
  const auth = await getUser(request, env);
  if (!auth.user) return json({ error: `Telegram authentication failed. Error: ${auth.reason ?? "unknown"}` }, 401);
  const user = auth.user;
  if (await isBanned(env.DB, user.id)) return json({ banned: true, error: "This account is blocked from the game." }, 403);
  await saveTelegramUser(env, user);

  const rows = await env.DB.prepare(
    "SELECT telegram_user_id, display_name, best_score FROM leaderboard ORDER BY best_score DESC, updated_at ASC LIMIT 100"
  ).bind().all<{ telegram_user_id: string; display_name: string; best_score: number }>();
  const entries = (rows.results ?? []).map((row, index) => ({
    rank: index + 1,
    telegram_user_id: row.telegram_user_id,
    display_name: row.display_name,
    best_score: Number(row.best_score) || 0,
  }));
  const me = entries.find((entry) => entry.telegram_user_id === user.id) ?? null;
  return json({ hidden: false, entries, me });
}

export async function onRequestPost({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!env.BOT_TOKEN || !env.DB) return json({ error: "Leaderboard is not configured" }, 500);

  let body: { initData?: unknown; score?: unknown };
  try {
    body = await request.json() as { initData?: unknown; score?: unknown };
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const auth = await authenticate(String(body.initData ?? ""), env.BOT_TOKEN);
  if (!auth.user) return json({ error: `اعتبار تلگرام تأیید نشد. کد خطا: ${auth.reason ?? "unknown"}` }, 401);
  const user = auth.user;

  const score = body.score;
  if (!Number.isSafeInteger(score) || typeof score !== "number" || score < 1 || score > 100_000) {
    return json({ error: "امتیاز نامعتبر است." }, 400);
  }
  if (await isBanned(env.DB, user.id)) return json({ banned: true, error: "این حساب از بازی مسدود شده است." }, 403);
  const [checkpointRow, bestRow] = await Promise.all([
    env.DB.prepare("SELECT checkpoint FROM player_checkpoints WHERE telegram_user_id = ?")
      .bind(user.id).first<{ checkpoint: number }>(),
    env.DB.prepare("SELECT best_score FROM leaderboard WHERE telegram_user_id = ?")
      .bind(user.id).first<{ best_score: number }>(),
  ]);
  const checkpoint = Math.max(
    checkpointRow ? Number(checkpointRow.checkpoint) : 0,
    bestRow ? checkpointForScore(Number(bestRow.best_score)) : 0,
  );
  const scoreCheckpoint = checkpointForScore(score);
  if (scoreCheckpoint !== checkpoint) {
    await banAndDeleteUser(env.DB, user.id, "score_checkpoint_mismatch:" + score + "->" + checkpoint);
    return json({ banned: true, error: "امتیاز با checkpoint ثبت‌شده مطابقت نداشت؛ حساب مسدود شد." }, 403);
  }
  await saveTelegramUser(env, user);

  await env.DB.prepare(`
    INSERT INTO leaderboard (telegram_user_id, display_name, best_score, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      display_name = excluded.display_name,
      best_score = MAX(leaderboard.best_score, excluded.best_score),
      updated_at = CASE
        WHEN excluded.best_score > leaderboard.best_score THEN CURRENT_TIMESTAMP
        ELSE leaderboard.updated_at
      END
  `).bind(user.id, user.displayName, score).run();

  const row = await env.DB.prepare(
    "SELECT best_score FROM leaderboard WHERE telegram_user_id = ?"
  ).bind(user.id).first<{ best_score: number }>();

  return json({ ok: true, best_score: row?.best_score ?? score });
}
