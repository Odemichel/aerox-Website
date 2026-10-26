// supabase/functions/notify-admin-pending-bf/index.ts
//
// Prévient l'admin qu'un rider demande le rôle bike fitter depuis
// l'onboarding de l'app (`request_bike_fitter_role` → `pending_bf`), à
// valider dans le panneau admin.
//
// Appelée par le trigger `trg_notify_admin_pending_bf` (pg_net), qui ne
// porte pas de JWT : déployée avec `--no-verify-jwt`, authentifiée par
// l'en-tête `x-hook-secret` comparé à `BF_NOTIFY_SECRET` (même valeur que
// le secret Vault `bf_notify_secret`, partagé avec notify-admin-new-bf).
//
//   supabase functions deploy notify-admin-pending-bf --no-verify-jwt
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

// Les champs viennent du profil saisi par l'utilisateur : rien n'est inséré brut.
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Sujet d'e-mail : une seule ligne.
function oneLine(value: unknown): string {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const expected = Deno.env.get('BF_NOTIFY_SECRET');
  const given = req.headers.get('x-hook-secret') ?? '';
  if (!expected || !timingSafeEqual(given, expected)) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const { record } = await req.json();
    if (!record) return Response.json({ message: 'No record in payload' }, { status: 400 });
    if (record.role !== 'pending_bf') {
      return Response.json({ message: 'Not pending_bf, skipping' }, { status: 200 });
    }

    const smtpPass = Deno.env.get('SMTP_PASS');
    if (!smtpPass) {
      console.error('SMTP_PASS secret is not set');
      return Response.json({ error: 'SMTP_PASS not configured' }, { status: 500 });
    }

    const who = `${record.firstname ?? ''} ${record.name ?? ''}`.trim();
    const createdAt = record.created_at
      ? new Date(record.created_at).toLocaleDateString('fr-FR', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';

    const html = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a2e;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: #fff; margin: 0; font-size: 20px;">Nouvelle demande Bike-Fitter</h1>
  </div>
  <div style="border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 12px 12px; padding: 24px;">
    <p style="margin-top: 0;">Un utilisateur vient de s'inscrire en tant que <strong>Bike-Fitter</strong> et attend ta validation.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
      <tr><td style="padding: 8px 0; color: #666; width: 120px;">Nom</td><td style="padding: 8px 0; font-weight: 600;">${escapeHtml(who)}</td></tr>
      <tr><td style="padding: 8px 0; color: #666;">Email</td><td style="padding: 8px 0;">${escapeHtml(record.email ?? 'inconnu')}</td></tr>
      <tr><td style="padding: 8px 0; color: #666;">User ID</td><td style="padding: 8px 0; font-family: monospace; font-size: 13px;">${escapeHtml(record.id)}</td></tr>
      <tr><td style="padding: 8px 0; color: #666;">Langue</td><td style="padding: 8px 0;">${escapeHtml(record.lang ?? 'fr')}</td></tr>
      ${createdAt ? `<tr><td style="padding: 8px 0; color: #666;">Date</td><td style="padding: 8px 0;">${escapeHtml(createdAt)}</td></tr>` : ''}
    </table>
    <p style="margin-bottom: 0; color: #666; font-size: 13px;">
      Connecte-toi au panneau admin AeroX pour approuver ou refuser cette demande.
    </p>
  </div>
</body>
</html>`;

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false, // STARTTLS sur 587
      auth: { user: SMTP_USER, pass: smtpPass },
    });

    const info = await transporter.sendMail({
      from: SMTP_FROM,
      to: ADMIN_EMAILS,
      subject: oneLine(`[AeroX] Nouveau Bike-Fitter : ${who}`),
      html,
    });
    return Response.json({ message: 'Notification sent', messageId: info.messageId });
  } catch (error) {
    console.error('notify-admin-pending-bf error:', error);
    return Response.json({ error: error instanceof Error ? error.message : 'unknown' }, { status: 500 });
  }
});
