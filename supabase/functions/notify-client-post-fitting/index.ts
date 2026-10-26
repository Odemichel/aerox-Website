// supabase/functions/notify-client-post-fitting/index.ts
//
// E-mail au client d'un bike fitter après sa séance de fitting (au plus un
// par client et par jour, limite tenue par le trigger).
//
// Appelée par le trigger `notify_client_post_fitting` sur `sessions`
// (pg_net), qui ne porte pas de JWT : déployée avec `--no-verify-jwt`,
// authentifiée par l'en-tête `x-hook-secret` comparé à `BF_NOTIFY_SECRET`
// (même valeur que le secret Vault `bf_notify_secret`). Le client doit
// appartenir au bike fitter de la séance.
//
//   supabase functions deploy notify-client-post-fitting --no-verify-jwt
import nodemailer from "npm:nodemailer@6.9.16";
import { createClient } from "npm:@supabase/supabase-js@2";

const SMTP_HOST = "smtp.gmail.com";
const SMTP_PORT = 587;
const SMTP_USER = "olivier.demichel@aeroxbefaster.com";
const SMTP_FROM = '"AeroX BeFaster" <no-reply@aeroxbefaster.com>';

const SUPABASE_URL = "https://agvksgrjqskpetokudda.supabase.co";

type Locale = "fr" | "en" | "pt" | "es" | "it" | "de" | "nl" | "ja" | "tr";

interface Translations {
  subject: (studio: string) => string;
  greeting: string;
  congratsText: (studioHtml: string) => string;
  performanceText: string;
  resultsAvailable: string;
  ctaExisting: string;
  ctaNew: string;
  ctaNewSubtext: string;
  footer: string;
}

const NBSP = String.fromCharCode(0xa0);

const i18n: Record<Locale, Translations> = {
  fr: {
    subject: (studio) => `Votre séance de Bike Fitting chez ${studio}`,
    greeting: "Bonjour",
    congratsText: (studioHtml) => `Félicitations pour votre séance de Bike Fitting ${studioHtml}${NBSP}!`,
    performanceText: "Continuez à améliorer vos performances et votre aérodynamique grâce à AeroX, la seule application d'entraînement indoor qui mesure votre aérodynamisme en temps réel.",
    resultsAvailable: `Vos résultats sont disponibles dès maintenant${NBSP}:`,
    ctaExisting: "Accéder à mes résultats",
    ctaNew: "Découvrir AeroX",
    ctaNewSubtext: `Créez votre compte AeroX pour accéder à vos résultats de fitting et suivre votre progression${NBSP}:`,
    footer: "Cet email vous a été envoyé suite à votre séance de Bike Fitting. Si vous n'êtes pas à l'origine de cette séance, vous pouvez ignorer ce message.",
  },
  en: {
    subject: (studio) => `Your Bike Fitting session at ${studio}`,
    greeting: "Hello",
    congratsText: (studioHtml) => `Congratulations on your Bike Fitting session ${studioHtml}!`,
    performanceText: "Keep improving your performance and aerodynamics with AeroX, the only indoor training app that measures your aerodynamics in real time.",
    resultsAvailable: "Your results are available now:",
    ctaExisting: "Access my results",
    ctaNew: "Discover AeroX",
    ctaNewSubtext: "Create your AeroX account to access your fitting results and track your progress:",
    footer: "This email was sent following your Bike Fitting session. If you did not participate in this session, you can ignore this message.",
  },
  pt: {
    subject: (studio) => `A sua sessão de Bike Fitting em ${studio}`,
    greeting: "Olá",
    congratsText: (studioHtml) => `Parabéns pela sua sessão de Bike Fitting ${studioHtml}!`,
    performanceText: "Continue a melhorar o seu desempenho e aerodinâmica com a AeroX, a única aplicação de treino indoor que mede a sua aerodinâmica em tempo real.",
    resultsAvailable: "Os seus resultados estão disponíveis agora:",
    ctaExisting: "Aceder aos meus resultados",
    ctaNew: "Descobrir a AeroX",
    ctaNewSubtext: "Crie a sua conta AeroX para aceder aos seus resultados de fitting e acompanhar a sua evolução:",
    footer: "Este email foi enviado na sequência da sua sessão de Bike Fitting. Se não participou nesta sessão, pode ignorar esta mensagem.",
  },
  es: {
    subject: (studio) => `Tu sesión de Bike Fitting en ${studio}`,
    greeting: "Hola",
    congratsText: (studioHtml) => `¡Felicidades por tu sesión de Bike Fitting ${studioHtml}!`,
    performanceText: "Sigue mejorando tu rendimiento y aerodinámica con AeroX, la única aplicación de entrenamiento indoor que mide tu aerodinámica en tiempo real.",
    resultsAvailable: "Tus resultados están disponibles ahora:",
    ctaExisting: "Acceder a mis resultados",
    ctaNew: "Descubrir AeroX",
    ctaNewSubtext: "Crea tu cuenta AeroX para acceder a tus resultados de fitting y seguir tu progreso:",
    footer: "Este email te fue enviado tras tu sesión de Bike Fitting. Si no participaste en esta sesión, puedes ignorar este mensaje.",
  },
  it: {
    subject: (studio) => `La tua sessione di Bike Fitting presso ${studio}`,
    greeting: "Ciao",
    congratsText: (studioHtml) => `Complimenti per la tua sessione di Bike Fitting ${studioHtml}!`,
    performanceText: "Continua a migliorare le tue prestazioni e la tua aerodinamica con AeroX, l'unica app di allenamento indoor che misura la tua aerodinamica in tempo reale.",
    resultsAvailable: "I tuoi risultati sono disponibili ora:",
    ctaExisting: "Accedi ai miei risultati",
    ctaNew: "Scopri AeroX",
    ctaNewSubtext: "Crea il tuo account AeroX per accedere ai risultati del fitting e seguire i tuoi progressi:",
    footer: "Questa email ti è stata inviata in seguito alla tua sessione di Bike Fitting. Se non hai partecipato a questa sessione, puoi ignorare questo messaggio.",
  },
  de: {
    subject: (studio) => `Ihre Bike Fitting Sitzung bei ${studio}`,
    greeting: "Hallo",
    congratsText: (studioHtml) => `Herzlichen Glückwunsch zu Ihrer Bike Fitting Sitzung ${studioHtml}!`,
    performanceText: "Verbessern Sie weiterhin Ihre Leistung und Aerodynamik mit AeroX, der einzigen Indoor-Trainings-App, die Ihre Aerodynamik in Echtzeit misst.",
    resultsAvailable: "Ihre Ergebnisse sind jetzt verfügbar:",
    ctaExisting: "Zu meinen Ergebnissen",
    ctaNew: "AeroX entdecken",
    ctaNewSubtext: "Erstellen Sie Ihr AeroX-Konto, um auf Ihre Fitting-Ergebnisse zuzugreifen und Ihren Fortschritt zu verfolgen:",
    footer: "Diese E-Mail wurde Ihnen nach Ihrer Bike Fitting Sitzung gesendet. Falls Sie nicht an dieser Sitzung teilgenommen haben, können Sie diese Nachricht ignorieren.",
  },
  nl: {
    subject: (studio) => `Uw Bike Fitting sessie bij ${studio}`,
    greeting: "Hallo",
    congratsText: (studioHtml) => `Gefeliciteerd met uw Bike Fitting sessie ${studioHtml}!`,
    performanceText: "Blijf uw prestaties en aerodynamica verbeteren met AeroX, de enige indoor trainingsapp die uw aerodynamica in realtime meet.",
    resultsAvailable: "Uw resultaten zijn nu beschikbaar:",
    ctaExisting: "Naar mijn resultaten",
    ctaNew: "Ontdek AeroX",
    ctaNewSubtext: "Maak uw AeroX-account aan om uw fitting-resultaten te bekijken en uw voortgang te volgen:",
    footer: "Deze e-mail is verzonden naar aanleiding van uw Bike Fitting sessie. Als u niet aan deze sessie heeft deelgenomen, kunt u dit bericht negeren.",
  },
  ja: {
    subject: (studio) => `${studio}でのバイクフィッティングセッション`,
    greeting: "こんにちは",
    congratsText: (studioHtml) => `${studioHtml}でのバイクフィッティングセッション、おめでとうございます！`,
    performanceText: "AeroXで引き続きパフォーマンスとエアロダイナミクスを向上させましょう。リアルタイムでエアロダイナミクスを測定できる唯一のインドアトレーニングアプリです。",
    resultsAvailable: "結果はすぐにご覧いただけます：",
    ctaExisting: "結果を確認する",
    ctaNew: "AeroXを発見する",
    ctaNewSubtext: "AeroXアカウントを作成して、フィッティング結果にアクセスし、進捗を追跡しましょう：",
    footer: "このメールはバイクフィッティングセッションに関連して送信されました。このセッションに心当たりがない場合は、このメッセージを無視してください。",
  },
  tr: {
    subject: (studio) => `${studio}'deki Bike Fitting seansınız`,
    greeting: "Merhaba",
    congratsText: (studioHtml) => `${studioHtml}'deki Bike Fitting seansınız için tebrikler!`,
    performanceText: "AeroX ile performansınızı ve aerodinamiğinizi geliştirmeye devam edin. Aerodinamiğinizi gerçek zamanlı ölçen tek iç mekan antrenman uygulaması.",
    resultsAvailable: "Sonuçlarınız şimdi mevcut:",
    ctaExisting: "Sonuçlarıma eriş",
    ctaNew: "AeroX'u keşfet",
    ctaNewSubtext: "Fitting sonuçlarınıza erişmek ve ilerlemenizi takip etmek için AeroX hesabınızı oluşturun:",
    footer: "Bu e-posta Bike Fitting seansınız sonrasında gönderilmiştir. Bu seansa katılmadıysanız bu mesajı görmezden gelebilirsiniz.",
  },
};

const studioPreposition: Record<Locale, { named: string; unnamed: string }> = {
  fr: { named: "chez", unnamed: "avec" },
  en: { named: "at", unnamed: "with" },
  pt: { named: "em", unnamed: "com" },
  es: { named: "en", unnamed: "con" },
  it: { named: "presso", unnamed: "con" },
  de: { named: "bei", unnamed: "mit" },
  nl: { named: "bij", unnamed: "met" },
  ja: { named: "の", unnamed: "の" },
  tr: { named: "'deki", unnamed: "ile" },
};

// Comparaison à temps constant (voir notify-admin-lead).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Nom du studio et prénoms saisis par les utilisateurs : rien n'est inséré brut.
function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Sujet d'e-mail : une seule ligne.
function oneLine(value: unknown): string {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const expected = Deno.env.get("BF_NOTIFY_SECRET");
  const given = req.headers.get("x-hook-secret") ?? "";
  if (!expected || !timingSafeEqual(given, expected)) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const { client_id, bf_user_id } = await req.json();

    if (!client_id || !bf_user_id) {
      return Response.json({ message: "Missing client_id or bf_user_id" }, { status: 400 });
    }

    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceRoleKey) {
      return Response.json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured" }, { status: 500 });
    }

    const supabase = createClient(SUPABASE_URL, serviceRoleKey);

    // Le client doit appartenir au bike fitter de la séance.
    const { data: client, error: clientErr } = await supabase
      .from("bf_clients")
      .select("email, firstname, lastname, bf_user_id")
      .eq("id", client_id)
      .single();

    if (clientErr || !client) {
      console.error("Client fetch error:", clientErr);
      return Response.json({ error: "Client not found" }, { status: 400 });
    }
    if (client.bf_user_id !== bf_user_id) {
      return Response.json({ error: "Client does not belong to this bike fitter" }, { status: 403 });
    }

    if (!client.email) {
      return Response.json({ message: "Client has no email, skipping" }, { status: 200 });
    }

    // Fetch BF user info (including lang for email locale)
    const { data: bfUser, error: bfErr } = await supabase
      .from("users")
      .select("studio_name, firstname, name, lang")
      .eq("id", bf_user_id)
      .single();

    if (bfErr || !bfUser) {
      console.error("BF user fetch error:", bfErr);
      return Response.json({ error: "BF user not found" }, { status: 400 });
    }

    // Check if client has an AeroX account (and get their lang preference)
    const { data: existingUser } = await supabase
      .from("users")
      .select("id, lang")
      .eq("email", client.email)
      .limit(1)
      .maybeSingle();

    const hasAccount = !!existingUser;
    const validLocales = ["fr", "en", "pt", "es", "it", "de", "nl", "ja", "tr"];
    // Client existant → sa langue ; nouveau client → langue du BF
    const rawLang = hasAccount ? (existingUser.lang || bfUser.lang) : bfUser.lang;
    const lang: Locale = (validLocales.includes(rawLang) ? rawLang : "fr") as Locale;
    const t = i18n[lang];
    const prep = studioPreposition[lang];
    const studioName = bfUser.studio_name || (lang === "fr" ? "votre Bike-Fitter" : lang === "en" ? "your Bike-Fitter" : lang === "pt" ? "o seu Bike-Fitter" : "tu Bike-Fitter");
    const subject = oneLine(t.subject(studioName));
    const clientFirstname = client.firstname || "";
    const bfFullName = [bfUser.firstname, bfUser.name].filter(Boolean).join(" ") || studioName;

    const studioHtml = bfUser.studio_name
      ? `${prep.named} <strong style="color: hsl(35, 95%, 58%);">${escapeHtml(bfUser.studio_name)}</strong>`
      : `${prep.unnamed} <strong style="color: hsl(35, 95%, 58%);">${escapeHtml(bfFullName)}</strong>`;

    const ctaBlock = hasAccount
      ? `
    <p style="margin: 24px 0 8px;">${t.resultsAvailable}</p>
    <div style="text-align: center; margin: 24px 0;">
      <a href="https://aerox-mycompanion.vercel.app" style="display: inline-block; padding: 14px 32px; background: hsl(35, 95%, 58%); color: #001F33; font-weight: 700; text-decoration: none; border-radius: 8px; font-size: 16px;">${t.ctaExisting}</a>
    </div>`
      : `
    <p style="margin: 24px 0 8px;">${t.ctaNewSubtext}</p>
    <div style="text-align: center; margin: 24px 0;">
      <a href="https://aeroxbefaster.com" style="display: inline-block; padding: 14px 32px; background: hsl(35, 95%, 58%); color: #001F33; font-weight: 700; text-decoration: none; border-radius: 8px; font-size: 16px;">${t.ctaNew}</a>
    </div>`;

    const htmlBody = `
<!DOCTYPE html>
<html lang="${lang}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #e0e0e0; background: #001F33;">
  <div style="background: linear-gradient(135deg, #001F33 0%, #003355 100%); padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: hsl(35, 95%, 58%); margin: 0; font-size: 22px;">AeroX BeFaster</h1>
    <p style="color: #ccc; margin: 8px 0 0; font-size: 14px;">Bike Fitting</p>
  </div>
  <div style="background: #002A44; border: 1px solid #004466; border-top: none; border-radius: 0 0 12px 12px; padding: 24px;">
    <p style="margin-top: 0; font-size: 16px;">${t.greeting}${clientFirstname ? " " + escapeHtml(clientFirstname) : ""},</p>
    <p>${t.congratsText(studioHtml)}</p>
    <p>${t.performanceText}</p>
    ${ctaBlock}
    <hr style="border: none; border-top: 1px solid #004466; margin: 24px 0;">
    <p style="margin-bottom: 0; color: #8899aa; font-size: 13px;">
      ${t.footer}
    </p>
  </div>
</body>
</html>`;

    const smtpPass = Deno.env.get("SMTP_PASS");
    if (!smtpPass) {
      console.error("SMTP_PASS secret is not set");
      return Response.json({ error: "SMTP_PASS not configured" }, { status: 500 });
    }

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false, // STARTTLS on port 587
      auth: {
        user: SMTP_USER,
        pass: smtpPass,
      },
    });

    const info = await transporter.sendMail({
      from: SMTP_FROM,
      to: client.email,
      subject,
      html: htmlBody,
    });

    console.log("Email sent, messageId:", info.messageId);
    return Response.json({ message: "Notification sent", messageId: info.messageId }, { status: 200 });
  } catch (error) {
    console.error("notify-client-post-fitting error:", error);
    return Response.json({ error: error instanceof Error ? error.message : "unknown" }, { status: 500 });
  }
});
