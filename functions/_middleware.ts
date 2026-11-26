import { hasValidAccessCookie } from "./_shared/access";

type Env = { BOT_TOKEN?: string };

const ALLOWED_BROWSER_IP = "91.107.177.183";
const PUBLIC_PATHS = new Set(["/api/access", "/api/telegram"]);

function forbiddenJson(): Response {
  return new Response(JSON.stringify({
    allowed: false,
    error: "دسترسی مجاز نیست. برای بازی، از طریق ربات تلگرام وارد شوید.",
  }), {
    status: 403,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function telegramGatePage(): Response {
  const html = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>تأیید دسترسی | Qubo</title>
  <style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#101522;color:#f4f6fb;font-family:system-ui,sans-serif}
    main{width:min(440px,100%);padding:28px;border:1px solid #30394d;border-radius:20px;background:#192235;text-align:center;box-shadow:0 18px 60px #0005}
    h1{font-size:1.35rem;margin:0 0 12px}p{line-height:1.9;color:#c7d0e0;margin:0}
    button{margin-top:20px;padding:11px 22px;border:0;border-radius:12px;background:#7c9cff;color:#101522;font-weight:700;font-size:1rem;cursor:pointer}
  </style>
</head>
<body>
  <main>
    <h1>تأیید دسترسی به Qubo</h1>
    <p id="access-message">در حال بررسی ورود تلگرام…</p>
    <button id="retry" type="button" hidden>تلاش دوباره</button>
  </main>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script>
    const message = document.getElementById("access-message");
    const retry = document.getElementById("retry");
    let busy = false;
    async function verifyTelegram() {
      if (busy) return;
      busy = true;
      retry.hidden = true;
      const initData = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData;
      if (!initData) {
        message.textContent = "این بازی فقط از طریق ربات تلگرام یا IP مجاز قابل دسترسی است. لینک را داخل ربات Qubo باز کنید.";
        retry.hidden = false;
        busy = false;
        return;
      }
      try {
        const response = await fetch("/api/access", {
          method: "POST",
          headers: { "x-telegram-init-data": initData },
          credentials: "same-origin",
          cache: "no-store"
        });
        if (response.ok) {
          message.textContent = "ورود تأیید شد؛ در حال انتقال…";
          window.location.replace(window.location.href);
          return;
        }
        const data = await response.json().catch(() => ({}));
        message.textContent = data.error || "تأیید ورود انجام نشد. دوباره از ربات وارد شوید.";
      } catch {
        message.textContent = "ارتباط با سرور برقرار نشد. اتصال اینترنت را بررسی و دوباره تلاش کنید.";
      }
      retry.hidden = false;
      busy = false;
    }
    retry.addEventListener("click", verifyTelegram);
    window.setTimeout(verifyTelegram, 0);
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 403,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

export async function onRequest({
  request,
  env,
  next,
}: {
  request: Request;
  env: Env;
  next: () => Promise<Response>;
}): Promise<Response> {
  const url = new URL(request.url);
  if (PUBLIC_PATHS.has(url.pathname)) return next();

  const clientIp = request.headers.get("CF-Connecting-IP")?.trim() ?? "";
  if (clientIp === ALLOWED_BROWSER_IP) return next();

  if (env.BOT_TOKEN && await hasValidAccessCookie(request, env.BOT_TOKEN)) {
    return next();
  }

  const accept = request.headers.get("Accept") ?? "";
  const isDocumentNavigation =
    request.headers.get("Sec-Fetch-Dest") === "document" ||
    accept.includes("text/html");

  if (isDocumentNavigation && request.method === "GET") {
    return telegramGatePage();
  }

  return forbiddenJson();
}
