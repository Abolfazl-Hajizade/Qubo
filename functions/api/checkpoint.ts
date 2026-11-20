type Env = {
  BOT_TOKEN?: string;
  DB: {
    prepare(query: string): {
      bind(...values: unknown[]): {
        first<T = Record<string, unknown>>(): Promise<T | null>;
        run(): Promise<unknown>;
      };
    };
  };
};

type TelegramUser = { id: number; first_name?: string; last_name?: string; username?: string };
type AuthenticatedUser = { id: string; username: string | null; firstName: string | null; lastName: string | null };

const encoder = new TextEncoder();

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
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = new Uint8Array(await hmac(encoder.encode("WebAppData"), botToken));
  const expectedHash = hex(await hmac(secret, dataCheckString));
  if (expectedHash.length !== receivedHash.length) return null;
  let mismatch = 0;
  for (let i = 0; i < expectedHash.length; i++) mismatch |= expectedHash.charCodeAt(i) ^ receivedHash.toLowerCase().charCodeAt(i);
  if (mismatch !== 0) return null;

  try {
    const user = JSON.parse(userValue) as TelegramUser;
    return Number.isSafeInteger(user.id) && user.id > 0 ? { id: String(user.id), username: user.username ?? null, firstName: user.first_name ?? null, lastName: user.last_name ?? null } : null;
  } catch {
    return null;
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

async function getAuthenticatedUser(request: Request, env: Env): Promise<AuthenticatedUser | null> {
  if (!env.BOT_TOKEN) return null;
  const initData = request.method === "POST"
    ? String((await request.clone().json().catch(() => ({})) as { initData?: unknown }).initData ?? "")
    : request.headers.get("x-telegram-init-data") ?? "";
  return authenticate(initData, env.BOT_TOKEN);
}

export async function onRequestGet({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!env.BOT_TOKEN || !env.DB) return json({ error: "Checkpoint sync is not configured" }, 500);
  const user = await getAuthenticatedUser(request, env);
  if (!user) return json({ error: "اعتبار تلگرام تأیید نشد." }, 401);
  await saveTelegramUser(env, user);
  const row = await env.DB.prepare(
    "SELECT checkpoint FROM player_checkpoints WHERE telegram_user_id = ?"
  ).bind(user.id).first<{ checkpoint: number }>();
  return json({ checkpoint: row?.checkpoint ?? 0, hasCheckpoint: row !== null });
}

export async function onRequestPost({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!env.BOT_TOKEN || !env.DB) return json({ error: "Checkpoint sync is not configured" }, 500);
  let body: { initData?: unknown; checkpoint?: unknown };
  try {
    body = await request.json() as { initData?: unknown; checkpoint?: unknown };
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const user = await authenticate(String(body.initData ?? ""), env.BOT_TOKEN);
  if (!user) return json({ error: "اعتبار تلگرام تأیید نشد." }, 401);
  await saveTelegramUser(env, user);

  const checkpoint = body.checkpoint;
  if (typeof checkpoint !== "number" || !Number.isSafeInteger(checkpoint)
      || checkpoint < 0 || checkpoint > 100_000 || checkpoint % 30 !== 0) {
    return json({ error: "Checkpoint نامعتبر است." }, 400);
  }

  await env.DB.prepare(`
    INSERT INTO player_checkpoints (telegram_user_id, checkpoint, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      checkpoint = MAX(player_checkpoints.checkpoint, excluded.checkpoint),
      updated_at = CASE
        WHEN excluded.checkpoint > player_checkpoints.checkpoint THEN CURRENT_TIMESTAMP
        ELSE player_checkpoints.updated_at
      END
  `).bind(user.id, checkpoint).run();

  return json({ ok: true });
}
