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

type TelegramUser = { id: number; first_name?: string; last_name?: string; username?: string };
type AuthenticatedUser = { id: string; displayName: string };
type DeviceSettings = {
  enabled: boolean;
  baseRenderScale: number;
  currentRenderScale: number;
  adjustmentCount: number;
  devicePixelRatio: number;
};
type GameStat = {
  telegram_user_id: string;
  display_name: string;
  game_count: number;
  base_render_scale: number | null;
  current_render_scale: number | null;
  adaptive_enabled: number | null;
  adaptive_change_count: number | null;
  device_pixel_ratio: number | null;
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
    return { id: String(user.id), displayName: displayName.slice(0, 80) };
  } catch { return null; }
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function onRequestPost({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!env.BOT_TOKEN || !env.DB) return json({ error: "Game statistics are not configured" }, 500);
  let body: { initData?: unknown; deviceSettings?: unknown; settingsOnly?: unknown };
  try { body = await request.json() as { initData?: unknown; deviceSettings?: unknown; settingsOnly?: unknown }; }
  catch { return json({ error: "Invalid JSON" }, 400); }
  const user = await authenticate(String(body.initData ?? ""), env.BOT_TOKEN);
  if (!user) return json({ error: "اعتبار تلگرام تأیید نشد." }, 401);

  const raw = body.deviceSettings as Partial<DeviceSettings> | undefined;
  const validSettings = !!raw
    && raw.enabled === true
    && typeof raw.baseRenderScale === "number" && Number.isFinite(raw.baseRenderScale) && raw.baseRenderScale >= 1 && raw.baseRenderScale <= 4
    && typeof raw.currentRenderScale === "number" && Number.isFinite(raw.currentRenderScale) && raw.currentRenderScale >= 1 && raw.currentRenderScale <= 4
    && Number.isSafeInteger(raw.adjustmentCount) && (raw.adjustmentCount ?? -1) >= 0 && (raw.adjustmentCount ?? 10001) <= 10000
    && typeof raw.devicePixelRatio === "number" && Number.isFinite(raw.devicePixelRatio) && raw.devicePixelRatio >= 0.5 && raw.devicePixelRatio <= 8;
  if (body.deviceSettings !== undefined && !validSettings) return json({ error: "تنظیمات دستگاه نامعتبر است." }, 400);
  if (body.settingsOnly === true && !validSettings) return json({ error: "تنظیمات دستگاه ارسال نشده است." }, 400);

  const settings = validSettings ? raw! : null;
  const values = settings
    ? [settings.baseRenderScale, settings.currentRenderScale, settings.enabled ? 1 : 0, settings.adjustmentCount, settings.devicePixelRatio]
    : [null, null, null, null, null];

  if (body.settingsOnly === true) {
    await env.DB.prepare(`
      INSERT INTO player_game_stats (
        telegram_user_id, display_name, game_count, base_render_scale,
        current_render_scale, adaptive_enabled, adaptive_change_count, device_pixel_ratio, updated_at
      ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        display_name = excluded.display_name,
        base_render_scale = excluded.base_render_scale,
        current_render_scale = excluded.current_render_scale,
        adaptive_enabled = excluded.adaptive_enabled,
        adaptive_change_count = excluded.adaptive_change_count,
        device_pixel_ratio = excluded.device_pixel_ratio,
        updated_at = CURRENT_TIMESTAMP
    `).bind(user.id, user.displayName, ...values).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO player_game_stats (
        telegram_user_id, display_name, game_count, base_render_scale,
        current_render_scale, adaptive_enabled, adaptive_change_count, device_pixel_ratio, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        display_name = excluded.display_name,
        game_count = player_game_stats.game_count + 1,
        base_render_scale = COALESCE(excluded.base_render_scale, player_game_stats.base_render_scale),
        current_render_scale = COALESCE(excluded.current_render_scale, player_game_stats.current_render_scale),
        adaptive_enabled = COALESCE(excluded.adaptive_enabled, player_game_stats.adaptive_enabled),
        adaptive_change_count = COALESCE(excluded.adaptive_change_count, player_game_stats.adaptive_change_count),
        device_pixel_ratio = COALESCE(excluded.device_pixel_ratio, player_game_stats.device_pixel_ratio),
        updated_at = CURRENT_TIMESTAMP
    `).bind(user.id, user.displayName, ...values).run();
  }
  return json({ ok: true });
}

export async function onRequestGet({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!env.BOT_TOKEN || !env.DB) return json({ error: "Game statistics are not configured" }, 500);
  const user = await authenticate(request.headers.get("x-telegram-init-data") ?? "", env.BOT_TOKEN);
  if (!user) return json({ error: "اعتبار تلگرام تأیید نشد." }, 401);
  if (user.id !== ADMIN_ID) return json({ error: "Forbidden" }, 403);
  const rows = await env.DB.prepare(`
    SELECT telegram_user_id, display_name, game_count,
      base_render_scale, current_render_scale, adaptive_enabled,
      adaptive_change_count, device_pixel_ratio
    FROM player_game_stats
    ORDER BY game_count DESC, display_name COLLATE NOCASE ASC
  `).bind().all<GameStat>();
  return json({ players: rows.results });
}
