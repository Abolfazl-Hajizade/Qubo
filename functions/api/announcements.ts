import { isBanned, type D1Like } from "../_shared/bans";
type Env = { BOT_TOKEN?: string; DB: D1Like };
type User = { id: string };
const ADMIN_ID = "7431567147";
const encoder = new TextEncoder();
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function hex(bytes: ArrayBuffer): string { return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join(""); }
async function hmac(key: Uint8Array, message: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, encoder.encode(message));
}
async function authenticate(data: string, token: string): Promise<User | null> {
  if (!data || data.length > 10000) return null;
  const p = new URLSearchParams(data), hash = p.get("hash"), rawUser = p.get("user"), date = Number(p.get("auth_date"));
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !rawUser || !Number.isFinite(date) || date > Date.now()/1000+60 || Date.now()/1000-date > 86400) return null;
  p.delete("hash");
  const check = [...p.entries()].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${k}=${v}`).join("\n");
  const secret = new Uint8Array(await hmac(encoder.encode("WebAppData"), token)), expected = hex(await hmac(secret, check));
  if (expected.length !== hash.length) return null;
  let mismatch = 0; for (let i=0;i<expected.length;i++) mismatch |= expected.charCodeAt(i) ^ hash.toLowerCase().charCodeAt(i);
  if (mismatch) return null;
  try { const u = JSON.parse(rawUser) as {id?:number}; return Number.isSafeInteger(u.id) && u.id! > 0 ? {id:String(u.id)} : null; } catch { return null; }
}
let schemaReady: Promise<void> | null = null;
async function ensureSchema(db: D1Like) {
  if (!schemaReady) schemaReady = (async () => {
    // Dedicated preview tables prevent announcements from this experiment reaching production.
    await db.prepare("CREATE TABLE IF NOT EXISTS preview_admin_announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by TEXT NOT NULL)").run();
    await db.prepare("CREATE TABLE IF NOT EXISTS preview_admin_announcement_reads (announcement_id INTEGER NOT NULL, telegram_user_id TEXT NOT NULL, read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (announcement_id, telegram_user_id))").run();
  })().catch(e => { schemaReady = null; throw e; });
  await schemaReady;
}
async function getUser(request: Request, env: Env, body?: {initData?:unknown}) {
  return env.BOT_TOKEN ? authenticate(request.method === "POST" ? String(body?.initData ?? "") : request.headers.get("x-telegram-init-data") ?? "", env.BOT_TOKEN) : null;
}
export async function onRequestGet({request,env}:{request:Request;env:Env}) {
  if (!env.DB || !env.BOT_TOKEN) return json({error:"Announcements not configured"},500);
  const user = await getUser(request,env); if (!user) return json({error:"اعتبار تلگرام تأیید نشد."},401);
  if (await isBanned(env.DB,user.id)) return json({banned:true},403);
  await ensureSchema(env.DB);
  const rows = await env.DB.prepare("SELECT a.id,a.message,a.created_at,CASE WHEN r.announcement_id IS NULL THEN 0 ELSE 1 END AS is_read FROM preview_admin_announcements a LEFT JOIN preview_admin_announcement_reads r ON r.announcement_id=a.id AND r.telegram_user_id=? ORDER BY a.id DESC LIMIT 50").bind(user.id).all<{id:number;message:string;created_at:string;is_read:number}>();
  return json({announcements:rows.results ?? [],is_admin:user.id===ADMIN_ID});
}
export async function onRequestPost({request,env}:{request:Request;env:Env}) {
  if (!env.DB || !env.BOT_TOKEN) return json({error:"Announcements not configured"},500);
  const body = await request.json().catch(()=>null) as {initData?:unknown;action?:unknown;message?:unknown;id?:unknown}|null;
  if (!body) return json({error:"Invalid JSON"},400);
  const user = await getUser(request,env,body); if (!user) return json({error:"اعتبار تلگرام تأیید نشد."},401);
  if (await isBanned(env.DB,user.id)) return json({banned:true},403);
  await ensureSchema(env.DB);
  if (body.action === "publish") {
    if (user.id !== ADMIN_ID) return json({error:"Forbidden"},403);
    if (typeof body.message !== "string" || !body.message.trim() || body.message.trim().length>1000) return json({error:"متن اعلان باید بین ۱ تا ۱۰۰۰ کاراکتر باشد."},400);
    await env.DB.prepare("INSERT INTO preview_admin_announcements(message,created_by) VALUES(?,?)").bind(body.message.trim(),user.id).run();
    return json({ok:true});
  }
  const id = Number(body.id);
  if (!Number.isSafeInteger(id) || id<=0) return json({error:"شناسه اعلان نامعتبر است."},400);
  if (body.action === "delete") {
    if (user.id !== ADMIN_ID) return json({error:"Forbidden"},403);
    await env.DB.prepare("DELETE FROM preview_admin_announcement_reads WHERE announcement_id=?").bind(id).run();
    await env.DB.prepare("DELETE FROM preview_admin_announcements WHERE id=?").bind(id).run();
    return json({ok:true});
  }
  if (body.action === "mark_read") {
    await env.DB.prepare("INSERT OR IGNORE INTO preview_admin_announcement_reads(announcement_id,telegram_user_id) SELECT id,? FROM preview_admin_announcements WHERE id=?").bind(user.id,id).run();
    return json({ok:true});
  }
  return json({error:"Unknown action"},400);
}
