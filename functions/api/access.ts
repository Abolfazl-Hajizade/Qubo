type Env = { BOT_TOKEN?: string };

const ALLOWED_BROWSER_IP = "91.107.177.183";
const encoder = new TextEncoder();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(keyBytes: Uint8Array, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, encoder.encode(message));
}

async function isValidTelegramInitData(initData: string, botToken: string): Promise<boolean> {
  if (!initData || initData.length > 10_000) return false;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  const authDateValue = params.get("auth_date");
  const userValue = params.get("user");
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash) || !authDateValue || !userValue) return false;
  const authDate = Number(authDateValue);
  if (!Number.isFinite(authDate) || authDate > Date.now() / 1000 + 60 || Date.now() / 1000 - authDate > 86_400) return false;
  params.delete("hash");
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = new Uint8Array(await hmac(encoder.encode("WebAppData"), botToken));
  const expectedHash = hex(await hmac(secret, dataCheckString));
  if (expectedHash.length !== receivedHash.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expectedHash.length; i++) mismatch |= expectedHash.charCodeAt(i) ^ receivedHash.toLowerCase().charCodeAt(i);
  if (mismatch !== 0) return false;
  try {
    const user = JSON.parse(userValue) as { id?: unknown };
    return Number.isSafeInteger(user.id) && Number(user.id) > 0;
  } catch {
    return false;
  }
}

export async function onRequestGet({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const clientIp = request.headers.get("CF-Connecting-IP")?.trim() ?? "";
  if (clientIp === ALLOWED_BROWSER_IP) return json({ allowed: true, method: "approved_ip" });

  const initData = request.headers.get("x-telegram-init-data") ?? "";
  if (env.BOT_TOKEN && await isValidTelegramInitData(initData, env.BOT_TOKEN)) {
    return json({ allowed: true, method: "telegram" });
  }

  return json({
    allowed: false,
    error: "برای بازی، از طریق ربات تلگرام وارد Qubo شوید.",
  }, 403);
}
