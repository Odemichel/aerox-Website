// supabase/functions/notify-bf-offer-reminder/index.ts
//
// Relance d'un bike fitter inscrit qui n'a pas encore choisi d'offre ni
// enregistré de carte : lien vers l'onglet Abonnement de son espace, dans sa
// langue. Bouton admin « Relancer » de la liste d'installation (app desktop,
// mycompanion).
//
// Appelée par `bf_send_offer_reminder()` (admin seulement, une relance par
// 24 h au plus). pg_net n'envoie pas de JWT : la fonction est déployée avec
// `--no-verify-jwt` et s'authentifie par l'en-tête `x-hook-secret`, comparé
// au secret `BF_NOTIFY_SECRET` (même secret que notify-bf-unpaid).
//
//   supabase functions deploy notify-bf-offer-reminder --no-verify-jwt
import nodemailer from 'npm:nodemailer@6.9.16';

const ADMIN_EMAILS = ['olivier.demichel@aeroxbefaster.com'];
const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 587;
const SMTP_USER = 'olivier.demichel@aeroxbefaster.com';
const SMTP_FROM = '"AeroX BeFaster" <no-reply@aeroxbefaster.com>';
const SITE_URL = 'https://aeroxbefaster.com';

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

interface Texts {
  subject: string;
  hello: (name: string) => string;
  body: string;
  trial: string;
  cta: string;
  help: string;
}

// Langues du site (chemins /{lang}/…) ; anglais par défaut.
const TEXTS: Record<string, Texts> = {
  fr: {
    subject: 'Votre espace AeroX est prêt : choisissez votre offre',
    hello: (n) => (n ? `Bonjour ${n},` : 'Bonjour,'),
    body: 'Votre compte bike fitter AeroX est créé. Pour démarrer, il reste à choisir votre offre et à enregistrer votre carte dans votre espace.',
    trial:
      'Rien n’est prélevé à cette étape : les 14 jours d’essai gratuit commencent à l’installation de votre setup, et le premier prélèvement n’a lieu qu’à leur terme.',
    cta: 'Choisir mon offre',
    help: 'Une question ? Répondez simplement à cet e-mail.',
  },
  en: {
    subject: 'Your AeroX space is ready: choose your plan',
    hello: (n) => (n ? `Hello ${n},` : 'Hello,'),
    body: 'Your AeroX bike fitter account is set up. To get started, choose your plan and save your card in your space.',
    trial:
      'Nothing is charged at this step: the 14-day free trial starts when your setup is installed, and the first payment only happens once it ends.',
    cta: 'Choose my plan',
    help: 'Any question? Just reply to this email.',
  },
  es: {
    subject: 'Tu espacio AeroX está listo: elige tu oferta',
    hello: (n) => (n ? `Hola ${n}:` : 'Hola:'),
    body: 'Tu cuenta de bike fitter AeroX está creada. Para empezar, solo falta elegir tu oferta y registrar tu tarjeta en tu espacio.',
    trial:
      'No se cobra nada en este paso: los 14 días de prueba gratuita empiezan con la instalación de tu equipo y el primer cobro solo llega al terminar.',
    cta: 'Elegir mi oferta',
    help: '¿Alguna pregunta? Responde a este correo.',
  },
  it: {
    subject: 'Il tuo spazio AeroX è pronto: scegli la tua offerta',
    hello: (n) => (n ? `Ciao ${n},` : 'Ciao,'),
    body: 'Il tuo account bike fitter AeroX è stato creato. Per iniziare, resta da scegliere l’offerta e registrare la carta nel tuo spazio.',
    trial:
      'In questa fase non viene addebitato nulla: i 14 giorni di prova gratuita iniziano con l’installazione del tuo setup e il primo addebito arriva solo alla loro fine.',
    cta: 'Scegli la mia offerta',
    help: 'Domande? Rispondi semplicemente a questa e-mail.',
  },
  de: {
    subject: 'Dein AeroX-Bereich ist bereit: wähle dein Angebot',
    hello: (n) => (n ? `Hallo ${n},` : 'Hallo,'),
    body: 'Dein AeroX-Bikefitter-Konto ist eingerichtet. Zum Start musst du nur noch dein Angebot wählen und deine Karte in deinem Bereich hinterlegen.',
    trial:
      'In diesem Schritt wird nichts abgebucht: Die 14 Tage kostenlose Testphase beginnen mit der Installation deines Setups, die erste Abbuchung erfolgt erst danach.',
    cta: 'Angebot wählen',
    help: 'Fragen? Antworte einfach auf diese E-Mail.',
  },
  nl: {
    subject: 'Je AeroX-omgeving is klaar: kies je abonnement',
    hello: (n) => (n ? `Hallo ${n},` : 'Hallo,'),
    body: 'Je AeroX-bikefitteraccount is aangemaakt. Om te beginnen kies je nog je abonnement en registreer je je kaart in je omgeving.',
    trial:
      'Er wordt in deze stap niets afgeschreven: de 14 dagen gratis proefperiode beginnen bij de installatie van je setup en de eerste betaling volgt pas daarna.',
    cta: 'Kies mijn abonnement',
    help: 'Vragen? Beantwoord gewoon deze e-mail.',
  },
  pt: {
    subject: 'Seu espaço AeroX está pronto: escolha sua oferta',
    hello: (n) => (n ? `Olá ${n},` : 'Olá,'),
    body: 'Sua conta de bike fitter AeroX foi criada. Para começar, falta escolher sua oferta e cadastrar seu cartão no seu espaço.',
    trial:
      'Nada é cobrado nesta etapa: os 14 dias de teste grátis começam na instalação do seu setup, e a primeira cobrança só acontece ao final deles.',
    cta: 'Escolher minha oferta',
    help: 'Alguma dúvida? Basta responder a este e-mail.',
  },
  ja: {
    subject: 'AeroXのマイページの準備ができました：プランをお選びください',
    hello: (n) => (n ? `${n} 様` : 'こんにちは。'),
    body: 'AeroXのバイクフィッターアカウントが作成されました。開始するには、マイページでプランを選び、カードを登録してください。',
    trial:
      'この段階で請求は発生しません。14日間の無料トライアルはセットアップの設置時に始まり、最初のお支払いはその終了後です。',
    cta: 'プランを選ぶ',
    help: 'ご質問はこのメールにご返信ください。',
  },
  tr: {
    subject: 'AeroX alanın hazır: teklifini seç',
    hello: (n) => (n ? `Merhaba ${n},` : 'Merhaba,'),
    body: 'AeroX bike fitter hesabın oluşturuldu. Başlamak için alanında teklifini seçip kartını kaydetmen yeterli.',
    trial:
      'Bu adımda hiçbir ücret alınmaz: 14 günlük ücretsiz deneme kurulumun yapıldığında başlar, ilk ödeme ancak bu süre bitince alınır.',
    cta: 'Teklifimi seç',
    help: 'Sorun mu var? Bu e-postayı yanıtlaman yeterli.',
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
    const email = String(p?.email ?? '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return Response.json({ error: 'invalid payload' }, { status: 400 });
    }

    const smtpPass = Deno.env.get('SMTP_PASS');
    if (!smtpPass) {
      console.error('SMTP_PASS secret is not set');
      return Response.json({ error: 'SMTP_PASS not configured' }, { status: 500 });
    }

    const lang = typeof p.lang === 'string' && p.lang in TEXTS ? p.lang : 'en';
    const T = TEXTS[lang];
    const url = `${SITE_URL}/${lang}/inscription/dashboard/#abonnement`;
    const name = escapeHtml(p.firstname || p.studio_name || '');

    const html = `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a2e;">
  <p>${T.hello(name)}</p>
  <p>${escapeHtml(T.body)}</p>
  <p>${escapeHtml(T.trial)}</p>
  <p style="margin: 28px 0;">
    <a href="${url}" style="background: #f59e0b; color: #1a1a2e; padding: 12px 22px; border-radius: 8px; text-decoration: none; font-weight: 600;">${escapeHtml(T.cta)}</a>
  </p>
  <p style="color: #555; font-size: 14px;">${escapeHtml(T.help)}</p>
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
      to: email,
      bcc: ADMIN_EMAILS,
      replyTo: SMTP_USER,
      subject: T.subject,
      html,
    });
    return Response.json({ message: 'Reminder sent', messageId: info.messageId });
  } catch (error) {
    console.error('notify-bf-offer-reminder error:', error);
    return Response.json({ error: error instanceof Error ? error.message : 'unknown' }, { status: 500 });
  }
});
