// supabase/functions/notify-bf-unpaid/index.ts
//
// Relance d'un bike fitter dont l'abonnement s'est terminé avec une facture
// impayée (créance conservée). Stripe ne l'envoie pas lui-même : l'envoi
// manuel d'une facture est réservé aux factures `send_invoice`.
//
// Appelée par `bf_send_unpaid_reminders()` (pg_cron, toutes les heures) à
// J+0, J+7 et J+21. pg_net n'envoie pas de JWT : la fonction est déployée
// avec `--no-verify-jwt` et s'authentifie par l'en-tête `x-hook-secret`,
// comparé au secret `BF_NOTIFY_SECRET` (même secret que notify-admin-new-bf).
//
//   supabase functions deploy notify-bf-unpaid --no-verify-jwt
import nodemailer from 'npm:nodemailer@6.9.16';

const ADMIN_EMAILS = ['olivier.demichel@aeroxbefaster.com'];
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

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Français pour les francophones, anglais pour toutes les autres langues
// (même règle que les e-mails MailerLite du compte).
const TEXT = {
  fr: {
    subject: (n: number) => (n > 1 ? 'Rappel : facture AeroX impayée' : 'Facture AeroX impayée'),
    hello: (name: string) => (name ? `Bonjour ${name},` : 'Bonjour,'),
    body: (amount: string) =>
      `Votre abonnement AeroX est terminé, mais une facture reste impayée : <strong>${amount} TTC</strong>.`,
    cta: 'Régler la facture',
    help: 'Le paiement se fait en ligne, par carte, sur la page sécurisée de Stripe. Une question ? Répondez simplement à cet e-mail.',
  },
  en: {
    subject: (n: number) => (n > 1 ? 'Reminder: unpaid AeroX invoice' : 'Unpaid AeroX invoice'),
    hello: (name: string) => (name ? `Hello ${name},` : 'Hello,'),
    body: (amount: string) =>
      `Your AeroX subscription has ended, but one invoice is still unpaid: <strong>${amount} incl. VAT</strong>.`,
    cta: 'Pay the invoice',
    help: 'Payment is made online by card, on Stripe’s secure page. Any question? Just reply to this email.',
  },
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const expected = Deno.env.get('BF_NOTIFY_SECRET');
  const given = req.headers.get('x-hook-secret') ?? '';
  if (!expected || !timingSafeEqual(given, expected)) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const p = await req.json();
    const url = String(p?.url ?? '');
    // Seule une page de paiement Stripe est acceptée comme lien.
    if (!p?.email || !/^https:\/\/invoice\.stripe\.com\//.test(url) || !(Number(p.amount) > 0)) {
      return Response.json({ error: 'invalid payload' }, { status: 400 });
    }

    const smtpPass = Deno.env.get('SMTP_PASS');
    if (!smtpPass) {
      console.error('SMTP_PASS secret is not set');
      return Response.json({ error: 'SMTP_PASS not configured' }, { status: 500 });
    }

    const lang = p.lang === 'fr' ? 'fr' : 'en';
    const T = TEXT[lang];
    const amount = new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', {
      style: 'currency',
      currency: 'EUR',
    }).format(Number(p.amount) / 100);
    const name = escapeHtml(p.firstname || p.studio_name || '');

    const html = `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a2e;">
  <p>${T.hello(name)}</p>
  <p>${T.body(escapeHtml(amount))}</p>
  <p style="margin: 28px 0;">
    <a href="${escapeHtml(url)}" style="background: #f59e0b; color: #1a1a2e; padding: 12px 22px; border-radius: 8px; text-decoration: none; font-weight: 600;">${T.cta}</a>
  </p>
  <p style="color: #555; font-size: 14px;">${T.help}</p>
  <p style="color: #555; font-size: 14px;">AeroX BeFaster</p>
</body></html>`;

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false, // STARTTLS sur 587
      auth: { user: SMTP_USER, pass: smtpPass },
    });

    const info = await transporter.sendMail({
      from: SMTP_FROM,
      to: p.email,
      bcc: ADMIN_EMAILS,
      replyTo: SMTP_USER,
      subject: T.subject(Number(p.reminder) || 1),
      html,
    });
    return Response.json({ message: 'Reminder sent', messageId: info.messageId });
  } catch (error) {
    console.error('notify-bf-unpaid error:', error);
    return Response.json({ error: error instanceof Error ? error.message : 'unknown' }, { status: 500 });
  }
});
