// supabase/functions/notify-admin-new-bf/index.ts
//
// Prévient l'admin qu'un bike fitter vient de s'inscrire. Depuis la facturation
// automatique, le compte est actif tout de suite : ce mail informe, il ne
// demande plus de validation. Seconde forme (`review`) : un identifiant
// d'entreprise hors registre public, à vérifier puis valider par le lien.
//
// Appelée par le trigger `trg_notify_admin_new_bf` (pg_net). pg_net n'envoie
// pas de JWT : la fonction est déployée avec `--no-verify-jwt` et
// s'authentifie par l'en-tête `x-hook-secret`, comparé au secret
// `BF_NOTIFY_SECRET` (même valeur que le secret Vault `bf_notify_secret`).
//
//   supabase functions deploy notify-admin-new-bf --no-verify-jwt
//   supabase secrets set BF_NOTIFY_SECRET=<valeur>
import nodemailer from 'npm:nodemailer@6.9.16';

const ADMIN_EMAILS = ['olivier.demichel@aeroxbefaster.com', 'olivier.demichel@gmail.com'];
const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 587;
const SMTP_USER = 'olivier.demichel@aeroxbefaster.com';
const SMTP_FROM = '"AeroX BeFaster" <no-reply@aeroxbefaster.com>';

// Comparaison à temps constant (voir notify-admin-lead).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Les champs viennent du formulaire d'inscription : rien n'est inséré brut.
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const expected = Deno.env.get('BF_NOTIFY_SECRET');
  const given = req.headers.get('x-hook-secret') ?? '';
  if (!expected || !timingSafeEqual(given, expected)) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const { record, review } = await req.json();
    if (!record) return Response.json({ message: 'No record in payload' }, { status: 400 });

    const smtpPass = Deno.env.get('SMTP_PASS');
    if (!smtpPass) {
      console.error('SMTP_PASS secret is not set');
      return Response.json({ error: 'SMTP_PASS not configured' }, { status: 500 });
    }

    const who = `${record.firstname ?? ''} ${record.name ?? ''}`.trim() || record.email || 'inconnu';
    const rows: [string, unknown][] = [
      ['Nom', who],
      ['Email', record.email],
      ['Studio', record.studio_name],
      ['Langue', record.lang],
      ['User ID', record.id],
    ];

    // Identifiant d'entreprise sans registre public (hors UE) : à vérifier à
    // la main, validation par le lien signé (voir bf_notify_business_review).
    if (review?.business_id) rows.unshift(['Identifiant', review.business_id]);
    const approve =
      typeof review?.approve_url === 'string' && review.approve_url.startsWith('https://')
        ? `<p style="margin: 24px 0;"><a href="${escapeHtml(review.approve_url)}" style="background: #f59e0b; color: #1a1a2e; padding: 12px 22px; border-radius: 8px; text-decoration: none; font-weight: 600;">Vérifier et valider</a></p>`
        : '';
    const intro = review
      ? `<h1 style="font-size: 20px;">Identifiant d'entreprise à vérifier</h1>
  <p>Un bike fitter a saisi un identifiant qu'aucun registre public ne permet de vérifier automatiquement. Vérifiez-le, puis validez : ses 2 analyses offertes s'ouvriront.</p>${approve}`
      : `<h1 style="font-size: 20px;">Nouveau bike fitter</h1>
  <p>Un bike fitter vient de créer son compte. Il est <strong>actif immédiatement</strong> ; ses 2 analyses offertes s'ouvrent avec l'identifiant de son entreprise.</p>`;

    const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a2e;">
  ${intro}
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    ${rows
      .filter(([, v]) => v)
      .map(
        ([k, v]) =>
          `<tr><td style="padding: 6px 0; color: #666; width: 120px;">${k}</td><td style="padding: 6px 0;">${escapeHtml(v)}</td></tr>`
      )
      .join('')}
  </table>
</body></html>`;

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false, // STARTTLS sur 587
      auth: { user: SMTP_USER, pass: smtpPass },
    });

    const info = await transporter.sendMail({
      from: SMTP_FROM,
      to: ADMIN_EMAILS,
      subject: review ? `[AeroX] Identifiant d'entreprise à vérifier : ${who}` : `[AeroX] Nouveau bike fitter : ${who}`,
      html,
    });
    return Response.json({ message: 'Notification sent', messageId: info.messageId });
  } catch (error) {
    console.error('notify-admin-new-bf error:', error);
    return Response.json({ error: error instanceof Error ? error.message : 'unknown' }, { status: 500 });
  }
});
