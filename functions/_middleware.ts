/**
 * Requests pass through to the Pages Functions.
 * Individual API routes enforce Telegram authentication and their own access rules.
 */
export async function onRequest({ next }: { request: Request; next: () => Promise<Response> }): Promise<Response> {
  return next();
}
