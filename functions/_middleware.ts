/**
 * Temporary incident-response lock: disable every API route while the game is
 * being restored and Telegram access is reviewed. Static/offline gameplay stays available.
 * Remove this middleware only after the backend has been secured.
 */
export async function onRequest({ request, next }: { request: Request; next: () => Promise<Response> }): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({
      error: "دسترسی آنلاین بازی موقتاً غیرفعال است.",
      code: "TEMPORARILY_DISABLED",
    }), {
      status: 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "3600",
      },
    });
  }
  return next();
}
