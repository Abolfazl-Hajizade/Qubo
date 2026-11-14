type Env = {
  BOT_TOKEN?: string;
  DB: {
    prepare(query: string): {
      bind(...values: unknown[]): {
        first<T = Record<string, unknown>>(): Promise<T | null>;
        all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
        run(): Promise<unknown>;
      };
    };
  };
};

type TelegramUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type AuthenticatedUser = {
  id: string;
  displayName: string;
};

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
  const authDate = Number(params.get("auth_date"));
  const userValue = params.get("user");
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash) || !userValue) return null;
  if (!Number.isFinite(authDate) || authDate > Date.now() / 1000 + 60 || Date.now() / 1000 - authDate > 86_400) return null;

  params.delete("hash");
  params.delete("signature");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = new Uint8Array(await hmac(encoder.encode(botToken), "WebAppData"));
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
    return { id: String(user.id), displayName: displayName.slice(0, 80) };
  } catch {
    return null;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function getUser(request: Request, env: Env): Promise<AuthenticatedUser | null> {
  if (!env.BOT_TOKEN) return null;
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
  const user = await getUser(request, env);
  if (!user) return json({ error: "اعتبار تلگرام نامعتبر یا منقضی شده است." }, 401);

  const entries = await env.DB.prepare(`
    WITH ranked AS (
      SELECT telegram_user_id, display_name, best_score,
        ROW_NUMBER() OVER (ORDER BY best_score DESC, updated_at ASC, telegram_user_id ASC) AS rank
      FROM leaderboard
    )
    SELECT telegram_user_id, display_name, best_score, rank
    FROM ranked ORDER BY rank LIMIT 50
  `).bind().all<LeaderboardRow>();

  const me = await env.DB.prepare(`
    WITH ranked AS (
      SELECT telegram_user_id, best_score,
        ROW_NUMBER() OVER (ORDER BY best_score DESC, updated_at ASC, telegram_user_id ASC) AS rank
      FROM leaderboard
    )
    SELECT rank, best_score FROM ranked WHERE telegram_user_id = ?
  `).bind(user.id).first<{ rank: number; best_score: number }>();

  return json({ entries: entries.results, me });
}

export async function onRequestPost({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!env.BOT_TOKEN || !env.DB) return json({ error: "Leaderboard is not configured" }, 500);

  let body: { initData?: unknown; score?: unknown };
  try {
    body = await request.json() as { initData?: unknown; score?: unknown };
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const user = await authenticate(String(body.initData ?? ""), env.BOT_TOKEN);
  if (!user) return json({ error: "اعتبار تلگرام نامعتبر یا منقضی شده است." }, 401);

  const score = body.score;
  if (!Number.isSafeInteger(score) || typeof score !== "number" || score < 1 || score > 100_000) {
    return json({ error: "امتیاز نامعتبر است." }, 400);
  }

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
