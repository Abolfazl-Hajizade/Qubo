type Env = {
  BOT_TOKEN?: string;
};

type TelegramUpdate = {
  message?: {
    chat?: { id?: number };
    text?: string;
  };
  inline_query?: {
    id: string;
    query?: string;
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

  const gameUrl = "https://qubo-c0i.pages.dev/qubo/index.html";

  if (update.inline_query) {
    const inlineResponse = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/answerInlineQuery`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inline_query_id: update.inline_query.id,
          results: [
            {
              type: "article",
              id: "qubo-game",
              title: "🎮 Play Qubo",
              description: "بازی Qubo را در تلگرام باز کن",
              input_message_content: {
                message_text: "🎮 بیا Qubo بازی کنیم!",
              },
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "▶️ Play Qubo",
                      url: gameUrl,
                    },
                  ],
                ],
              },
            },
          ],
          cache_time: 0,
          is_personal: true,
        }),
      },
    );

    if (!inlineResponse.ok) {
      return new Response("Telegram inline query failed", { status: 502 });
    }

    return new Response("ok");
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
                web_app: { url: gameUrl },
              },
            ],
            [
              {
                text: "▶️ play Qubo",
                web_app: { url: gameUrl },
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
