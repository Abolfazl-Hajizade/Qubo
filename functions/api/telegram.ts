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
              title: "🎮 Qubo",
              description: "بازی Qubo فعلاً غیرفعال است",
              input_message_content: {
                message_text: "بازی Qubo فعلاً در دسترس نیست.",
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
        text: "بازی Qubo فعلاً موقتاً غیرفعال است. لطفاً بعداً دوباره مراجعه کن.",
      }),
    },
  );

  if (!telegramResponse.ok) {
    return new Response("Telegram API request failed", { status: 502 });
  }

  return new Response("ok");
}
