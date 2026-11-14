type Env = {
  BOT_TOKEN?: string;
};

type TelegramUpdate = {
  message?: {
    chat?: { id?: number };
    text?: string;
  };
};

export async function onRequestPost({
  request,
  env,
}: {
  request: Request;
  env: Env;
}): Promise<Response> {
  if (!env.BOT_TOKEN) {
    return new Response("Bot is not configured", { status: 500 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const message = update.message;
  const chatId = message?.chat?.id;
  const text = message?.text?.trim() ?? "";

  if (!chatId || !text.startsWith("/start")) {
    return new Response("ok");
  }

  const telegramResponse = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "به بازی Qubo خوش اومدی! برای شروع روی دکمه زیر بزن 👇",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🎮 شروع بازی Qubo",
                web_app: {
                  url: "https://qubo-c0i.pages.dev/qubo/index.html",
                },
              },
            ],
          ],
        },
      }),
    },
  );

  if (!telegramResponse.ok) {
    return new Response("Telegram API request failed", { status: 502 });
  }

  return new Response("ok");
}
