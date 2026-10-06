// supabase/functions/crm-mailerlite/index.ts
//
// CRM privé (crm.aeroxbefaster.com) : renvoie ce que MailerLite sait d'un
// contact (groupes, champs bf_*, e-mails reçus, ouvertures, clics). Lecture
// seule. La clé MailerLite reste côté serveur ; seuls les membres du CRM
// (fonction SQL crm_is_member, appelée avec le jeton de l'utilisateur)
// obtiennent une réponse.
//
//   supabase functions deploy crm-mailerlite        (JWT vérifié par défaut)
//   supabase secrets set MAILERLITE_API_KEY=<clé>    (si absente)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const ALLOWED_ORIGINS = ['https://crm.aeroxbefaster.com', 'https://aerox-crm.vercel.app', 'http://localhost:5173'];
const MAILERLITE_TIMEOUT_MS = 8000;
const FIELDS = ['name', 'last_name', 'company', 'bf_status', 'bf_plan', 'bf_intent', 'bf_signup', 'lang'];

function cors(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

Deno.serve(async (req) => {
  const headers = cors(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers });

  const json = (body: unknown, status = 200) => Response.json(body, { status, headers });

  // Membre du CRM ? (le jeton de l'appelant est transmis tel quel)
  const authorization = req.headers.get('Authorization') ?? '';
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: isMember, error: memberError } = await supabase.rpc('crm_is_member');
  if (memberError || isMember !== true) return json({ error: 'forbidden' }, 403);

  let email = '';
  try {
    email = String((await req.json())?.email ?? '')
      .trim()
      .toLowerCase();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  if (!email || !email.includes('@')) return json({ error: 'bad_request' }, 400);

  const apiKey = Deno.env.get('MAILERLITE_API_KEY');
  if (!apiKey) {
    console.error('crm-mailerlite: MAILERLITE_API_KEY absent');
    return json({ status: 'unavailable' });
  }

  try {
    const res = await fetch(
      `https://connect.mailerlite.com/api/subscribers/${encodeURIComponent(email)}?include=groups`,
      {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(MAILERLITE_TIMEOUT_MS),
      }
    );
    if (res.status === 404) return json({ status: 'absent' });
    if (!res.ok) {
      console.error('crm-mailerlite: réponse MailerLite', res.status);
      return json({ status: 'unavailable' });
    }
    const s = (await res.json())?.data ?? {};
    const fields: Record<string, string> = {};
    for (const key of FIELDS) {
      const value = s.fields?.[key];
      if (value !== null && value !== undefined && value !== '') fields[key] = String(value);
    }
    return json({
      status: 'present',
      subscriber_status: s.status ?? null,
      subscribed_at: s.subscribed_at ?? s.created_at ?? null,
      groups: (s.groups ?? []).map((g: { name?: string }) => g.name).filter(Boolean),
      fields,
      sent: s.sent ?? 0,
      opens: s.opens_count ?? 0,
      clicks: s.clicks_count ?? 0,
    });
  } catch (err) {
    console.error('crm-mailerlite: appel MailerLite impossible', err);
    return json({ status: 'unavailable' });
  }
});
