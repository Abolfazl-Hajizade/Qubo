type Env = {
  BOT_TOKEN?: string;
  WEBHOOK_SECRET?: string;
};

export async function onRequestPost({
  request,
  env,
}: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const headers = { "content-type": "application/json; charset=utf-8" };

  if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "Bot secrets are not configured." }), { status: 500, headers });
  }

  let body: { setupSecret?: string };
  try {
    body = await request.json() as { setupSecret?: string };
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Invalid request." }), { status: 400, headers });
  }

  if (!body.setupSecret || body.setupSecret !== env.WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "Secret did not match." }), { status: 403, headers });
  }

  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://qubo-c0i.pages.dev/api/telegram",
      secret_token: env.WEBHOOK_SECRET,
    }),
  });

  const result = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || !result.ok) {
    return new Response(JSON.stringify({ ok: false, error: result.description ?? "Telegram setup failed." }), { status: 502, headers });
  }

  return new Response(JSON.stringify({ ok: true, message: "Telegram webhook connected." }), { headers });
}
