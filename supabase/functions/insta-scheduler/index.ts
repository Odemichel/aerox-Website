// insta-scheduler: publishes the Instagram posts queued by AeroX Studio, at their time, even with the Mac off.
// Called every minute by pg_cron (job « insta-scheduler », header x-cron-secret). A step machine, never a long wait:
//   queued (publish_at reached) -> containers created from signed URLs of the private bucket -> processing
//   processing -> container FINISHED -> media_publish -> published (files deleted from the bucket)
// Tables (service role only, RLS on, no policy): public.insta_schedule, public.insta_token (one row, refreshed here).
// Instagram API with Instagram Login (graph.instagram.com): no native scheduling, JPEG only for images, carousel = up
// to 10 children, 100 API posts per 24 h (developers.facebook.com/docs/instagram-platform/content-publishing).
import { createClient } from "jsr:@supabase/supabase-js@2";

const GRAPH = "https://graph.instagram.com/v25.0";
const BUCKET = "insta-transit";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

async function graph(method: string, path: string, params: Record<string, string>) {
  const url = path.startsWith("http") ? path : `${GRAPH}/${path}`;
  const body = new URLSearchParams(params);
  const res = method === "GET" ? await fetch(`${url}?${body}`) : await fetch(url, { method, body });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`${path}: ${j.error?.message ?? res.status}`);
  return j;
}

async function token() {
  const { data, error } = await sb.from("insta_token").select("*").eq("id", 1).single();
  if (error || !data) throw new Error("no Instagram token in insta_token (schedule once from AeroX Studio)");
  let tok = data.token as string;
  // long-lived tokens last 60 days; refresh every 5 days (allowed once the token is 24 h old)
  if (Date.now() - new Date(data.refreshed_at).getTime() > 5 * 86400e3) {
    try {
      const r = await graph("GET", "https://graph.instagram.com/refresh_access_token", { grant_type: "ig_refresh_token", access_token: tok });
      tok = r.access_token;
      await sb.from("insta_token").update({ token: tok, refreshed_at: new Date().toISOString() }).eq("id", 1);
    } catch (_) { /* keep the current one; it is still valid until it expires */ }
  }
  let uid = data.user_id as string | null;
  if (!uid) {
    uid = (await graph("GET", "me", { fields: "user_id", access_token: tok })).user_id;
    await sb.from("insta_token").update({ user_id: uid }).eq("id", 1);
  }
  return { tok, uid: uid! };
}

async function signed(path: string) {
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error || !data) throw new Error(`signed URL ${path}: ${error?.message}`);
  return data.signedUrl;
}

async function save(id: string, patch: Record<string, unknown>) {
  await sb.from("insta_schedule").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

async function start(row: any, tok: string, uid: string) {
  const media: string[] = row.media ?? [];
  const opt = row.options ?? {};
  if (row.kind === "reel") {
    const p: Record<string, string> = { media_type: "REELS", video_url: await signed(media[0]), caption: row.caption ?? "", access_token: tok };
    // trial reel: non-followers only; graduation MANUAL (in the app) or SS_PERFORMANCE (Meta, IG User Media trial_params)
    if (opt.trial === "MANUAL" || opt.trial === "SS_PERFORMANCE") p.trial_params = JSON.stringify({ graduation_strategy: opt.trial });
    else p.share_to_feed = String(opt.share_to_feed !== false);
    if (opt.thumb_ms != null) p.thumb_offset = String(opt.thumb_ms);
    const c = await graph("POST", `${uid}/media`, p);
    await save(row.id, { status: "processing", container_id: c.id, error: null });
  } else {
    if (media.length < 2 || media.length > 10) throw new Error(`a carousel needs 2 to 10 images, got ${media.length}`);
    const children: string[] = [];
    for (const m of media) {
      children.push((await graph("POST", `${uid}/media`, { image_url: await signed(m), is_carousel_item: "true", access_token: tok })).id);
    }
    const c = await graph("POST", `${uid}/media`, { media_type: "CAROUSEL", children: children.join(","), caption: row.caption ?? "", access_token: tok });
    await save(row.id, { status: "processing", container_id: c.id, children, error: null });
  }
}

async function finish(row: any, tok: string, uid: string) {
  const s = await graph("GET", row.container_id, { fields: "status_code,status", access_token: tok });
  if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error(`Instagram: ${s.status_code} ${s.status ?? ""}`);
  if (s.status_code !== "FINISHED") {
    if (Date.now() - new Date(row.updated_at).getTime() > 30 * 60e3) throw new Error(`still ${s.status_code} after 30 min`);
    return;   // next minute
  }
  const pub = await graph("POST", `${uid}/media_publish`, { creation_id: row.container_id, access_token: tok });
  const info = await graph("GET", pub.id, { fields: "permalink,timestamp", access_token: tok });
  await save(row.id, { status: "published", media_id: pub.id, permalink: info.permalink, published_at: info.timestamp ?? new Date().toISOString() });
  await sb.storage.from(BUCKET).remove(row.media ?? []);
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("INSTA_CRON_SECRET")) return new Response("forbidden", { status: 403 });
  const now = new Date().toISOString();
  const { data: rows, error } = await sb.from("insta_schedule").select("*")
    .or(`and(status.eq.queued,publish_at.lte.${now}),status.eq.processing`).order("publish_at").limit(5);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!rows?.length) return Response.json({ done: 0 });
  const { tok, uid } = await token();
  const out = [];
  for (const row of rows) {
    try {
      if (row.status === "queued") await start(row, tok, uid); else await finish(row, tok, uid);
      out.push({ id: row.id, ok: true });
    } catch (e) {
      const attempts = (row.attempts ?? 0) + 1;
      const msg = String((e as Error).message ?? e);
      // retry a few times (network, Instagram busy), then stop and say why; files stay for a manual retry
      await save(row.id, { attempts, error: msg, status: attempts >= 5 ? "failed" : row.status });
      out.push({ id: row.id, error: msg });
    }
  }
  return Response.json({ done: out.length, out });
});
