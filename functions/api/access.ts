import { createAccessCookie, getTelegramUserId, hasValidAccessCookie } from "../_shared/access";

type Env = { BOT_TOKEN?: string };

const ALLOWED_BROWSER_IP = "91.107.177.183";

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

async function authorize(request: Request, env: Env): Promise<Response> {
  const clientIp = request.headers.get("CF-Connecting-IP")?.trim() ?? "";
  if (clientIp === ALLOWED_BROWSER_IP) {
    return json({ allowed: true, method: "approved_ip" });
  }

  if (!env.BOT_TOKEN) {
    return json({ allowed: false, error: "Access service is not configured." }, 503);
  }

  if (await hasValidAccessCookie(request, env.BOT_TOKEN)) {
    return json({ allowed: true, method: "session" });
  }

  const initData = request.headers.get("x-telegram-init-data") ?? "";
  const userId = await getTelegramUserId(initData, env.BOT_TOKEN);
  if (!userId) {
    return json({
      allowed: false,
      error: "برای بازی، از طریق ربات تلگرام وارد Qubo شوید.",
    }, 403);
  }

  const cookie = await createAccessCookie(userId, env.BOT_TOKEN);
  return json(
    { allowed: true, method: "telegram" },
    200,
    { "set-cookie": cookie },
  );
}

export async function onRequestGet({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return authorize(request, env);
}

export async function onRequestPost({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return authorize(request, env);
}
