const encoder = new TextEncoder();
const COOKIE_NAME = "qubo_access";
const SESSION_SECONDS = 86_400;

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export async function getTelegramUserId(initData: string, botToken: string): Promise<string | null> {
  if (!initData || initData.length > 10_000) return null;

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  const authDateValue = params.get("auth_date");
  const userValue = params.get("user");

  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash) || !authDateValue || !userValue) return null;

  const authDate = Number(authDateValue);
  const now = Date.now() / 1000;
  if (!Number.isFinite(authDate) || authDate > now + 60 || now - authDate > SESSION_SECONDS) return null;

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const secret = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(botToken));
  const validationKey = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expectedHash = toHex(await crypto.subtle.sign("HMAC", validationKey, encoder.encode(dataCheckString)));

  if (expectedHash.length !== receivedHash.length) return null;
  let mismatch = 0;
  for (let i = 0; i < expectedHash.length; i++) {
    mismatch |= expectedHash.charCodeAt(i) ^ receivedHash.toLowerCase().charCodeAt(i);
  }
  if (mismatch !== 0) return null;

  try {
    const user = JSON.parse(userValue) as { id?: unknown };
    return Number.isSafeInteger(user.id) && Number(user.id) > 0 ? String(user.id) : null;
  } catch {
    return null;
  }
}

export async function createAccessCookie(userId: string, botToken: string): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = `${userId}.${expiresAt}`;
  const signature = await sign(`qubo-access|${payload}`, botToken);
  return `${COOKIE_NAME}=${payload}.${signature}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export async function hasValidAccessCookie(request: Request, botToken: string): Promise<boolean> {
  const cookieHeader = request.headers.get("Cookie") ?? "";
  const entry = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!entry) return false;

  const value = entry.slice(COOKIE_NAME.length + 1);
  const parts = value.split(".");
  if (parts.length !== 3) return false;

  const [userId, expiresAtValue, receivedSignature] = parts;
  if (!/^\d+$/.test(userId) || !/^\d+$/.test(expiresAtValue) || !/^[a-f0-9]{64}$/i.test(receivedSignature)) return false;

  const expiresAt = Number(expiresAtValue);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + SESSION_SECONDS + 60) return false;

  const expectedSignature = await sign(`qubo-access|${userId}.${expiresAtValue}`, botToken);
  if (expectedSignature.length !== receivedSignature.length) return false;

  let mismatch = 0;
  for (let i = 0; i < expectedSignature.length; i++) {
    mismatch |= expectedSignature.charCodeAt(i) ^ receivedSignature.toLowerCase().charCodeAt(i);
  }
  return mismatch === 0;
}
