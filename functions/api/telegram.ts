import type { D1Like } from "../_shared/bans";

type Env = {
  BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  DB?: D1Like;
};

type TelegramUpdate = {
  message?: {
    from?: { id?: number };
    chat?: { id?: number; type?: string };
    text?: string;
  };
  inline_query?: {
    id: string;
    query?: string;
  };
};

const ADMIN_TELEGRAM_ID = "7431567147";

async function sendTelegramMessage(botToken: string, chatId: number, text: string): Promise<boolean> {
  const response = await fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return response.ok;
}

function safeText(value: unknown, fallback: string): string {
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  return (text || fallback).slice(0, 80);
}


type BanRow = { telegram_user_id: string; reason: string; banned_at: string };
type DeletionRow = {
  telegram_user_id: string; username: string | null; first_name: string | null;
  last_name: string | null; display_name: string | null; reason: string;
  deleted_by: string; deleted_sections: string; deleted_at: string;
};

function splitTelegramText(lines: string[], maxLength = 3500): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? current + "\n" + line : line;
    if (next.length > maxLength && current) { chunks.push(current); current = line; }
    else current = next;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendBanAndDeletionLists(env: Env, chatId: number): Promise<boolean> {
  if (!env.BOT_TOKEN || !env.DB) return false;
  const [bannedResult, deletionResult] = await Promise.all([
    env.DB.prepare("SELECT telegram_user_id, reason, banned_at FROM banned_users ORDER BY banned_at DESC")
      .bind().all<BanRow>(),
    env.DB.prepare(
      "SELECT telegram_user_id, username, first_name, last_name, display_name, reason, deleted_by, deleted_sections, deleted_at " +
      "FROM user_deletion_audit ORDER BY deleted_at DESC, id DESC"
    ).bind().all<DeletionRow>(),
  ]);
  const banned = bannedResult.results ?? [];
  const deleted = deletionResult.results ?? [];
  const lines = [
    "🚫 کاربران مسدودشده Qubo: " + banned.length, "",
    ...(banned.length ? banned.map((u, i) => [
      (i + 1) + ". " + safeText(u.telegram_user_id, "بدون شناسه"),
      "دلیل: " + safeText(u.reason, "ثبت نشده"),
      "زمان مسدودسازی: " + safeText(u.banned_at, "نامشخص"),
    ].join("\n")) : ["موردی ثبت نشده است."]),
    "", "🗑 سابقه حذف کاربران Qubo: " + deleted.length, "",
    ...(deleted.length ? deleted.map((u, i) => {
      const fullName = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
      const name = safeText(fullName, safeText(u.display_name, "بدون نام"));
      const username = u.username ? "@" + safeText(u.username, "نامشخص") : "ثبت نشده";
      let sections = "نامشخص";
      try {
        const parsed = JSON.parse(u.deleted_sections);
        if (Array.isArray(parsed)) sections = parsed.map(x => safeText(x, "")).join(", ") || "ثبت نشده";
      } catch { sections = safeText(u.deleted_sections, "نامشخص"); }
      return [
        (i + 1) + ". " + name, "🆔 " + safeText(u.telegram_user_id, "بدون شناسه"),
        "👤 " + username, "دلیل: " + safeText(u.reason, "ثبت نشده"),
        "عامل حذف: " + safeText(u.deleted_by, "نامشخص"),
        "زمان حذف: " + safeText(u.deleted_at, "نامشخص"),
        "بخش‌های پاک‌شده: " + sections,
      ].join("\n");
    }) : ["موردی ثبت نشده است."]),
  ];
  for (const chunk of splitTelegramText(lines)) {
    if (!(await sendTelegramMessage(env.BOT_TOKEN, chatId, chunk))) return false;
  }
  return true;
}

async function sendMemberList(env: Env, chatId: number): Promise<boolean> {
  if (!env.BOT_TOKEN || !env.DB) return false;

  const rows = await env.DB.prepare(
    "SELECT l.telegram_user_id, t.username, " +
    "TRIM(COALESCE(t.first_name, '') || ' ' || COALESCE(t.last_name, '')) AS telegram_name, " +
    "l.display_name, l.best_score " +
    "FROM leaderboard l LEFT JOIN telegram_users t ON t.telegram_user_id = l.telegram_user_id " +
    "ORDER BY COALESCE(l.best_score, 0) DESC, l.updated_at DESC"
  ).bind().all<{
    telegram_user_id: string;
    username: string | null;
    telegram_name: string;
    display_name: string | null;
    best_score: number | null;
  }>();

  const players = rows.results ?? [];
  const lines = [
    "👥 فهرست بازیکنان Qubo — " + players.length + " نفر",
    "",
    ...players.map((player, index) => {
      const name = safeText(player.telegram_name, safeText(player.display_name, "بدون نام"));
      const username = player.username ? "@" + safeText(player.username, "ندارد") : "ندارد";
      const score = player.best_score == null ? "ثبت نشده" : String(Number(player.best_score) || 0);
      return [
        (index + 1) + ". " + name,
        "🆔 " + player.telegram_user_id,
        "👤 " + username,
        "🏆 آخرین رکورد ثبت‌شده: " + score,
      ].join("\n");
    }),
  ];

  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? current + "\n" + line : line;
    if (next.length > 3500 && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    if (!(await sendTelegramMessage(env.BOT_TOKEN, chatId, chunk))) return false;
  }
  return true;
}

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

  // Fail closed: never process webhook updates unless the secret is configured
  // and the request carries Telegram's matching secret header.
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Webhook secret is not configured", { status: 503 });
  }
  if (
    request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET
  ) {
    return new Response("Unauthorized", { status: 401 });
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
      "https://api.telegram.org/bot" + env.BOT_TOKEN + "/answerInlineQuery",
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
              description: "بازی Qubo را در چت بفرست",
              input_message_content: {
                message_text: "🎮 بیا Qubo بازی کنیم!",
              },
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "▶️ Play Qubo",
                      web_app: { url: gameUrl },
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
  const senderId = message?.from?.id;
  const text = message?.text?.trim() ?? "";

  // Telegram chat updates do not contain WebApp initData. The sender's ID is
  // supplied in the update; only answer in the admin's own private chat.
  if (
    /^\/ban(?:@\w+)?(?:\s|$)/i.test(text) &&
    message?.chat?.type === "private" &&
    senderId !== undefined &&
    String(senderId) === ADMIN_TELEGRAM_ID &&
    chatId !== undefined &&
    String(chatId) === ADMIN_TELEGRAM_ID
  ) {
    const sent = await sendBanAndDeletionLists(env, chatId);
    if (!sent) return new Response("Could not send ban and deletion lists", { status: 502 });
    return new Response("ok");
  }

  if (
    text === "/member" &&
    message?.chat?.type === "private" &&
    senderId !== undefined &&
    String(senderId) === ADMIN_TELEGRAM_ID &&
    chatId !== undefined &&
    String(chatId) === ADMIN_TELEGRAM_ID
  ) {
    const sent = await sendMemberList(env, chatId);
    if (!sent) return new Response("Could not send member list", { status: 502 });
    return new Response("ok");
  }

  if (!chatId || !text.startsWith("/start")) {
    return new Response("ok");
  }

  const telegramResponse = await fetch(
    "https://api.telegram.org/bot" + env.BOT_TOKEN + "/sendMessage",
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
