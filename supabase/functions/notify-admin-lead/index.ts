import nodemailer from "npm:nodemailer@6.9.16";

const ADMIN_EMAIL = "olivier.demichel@gmail.com";
const SMTP_HOST = "smtp.ionos.fr";
const SMTP_PORT = 587;
const SMTP_USER = "olivier.demichel@aeroxbefaster.com";
const SMTP_FROM = '"AeroX BeFaster" <no-reply@aeroxbefaster.com>';

const TOPIC_LABELS: Record<string, string> = {
  "test-period": "Demande de période de test",
  "bike-fitter": "Demande Bike-Fitter",
};

const FIELD_LABELS: Record<string, string> = {
  name: "Nom",
  email: "Email",
  lang: "Langue",
  availability: "Disponibilités",
  trainer: "Home-trainer",
  webcam: "Webcam",
  message: "Message",
};

// Les valeurs proviennent d'un formulaire public : rien n'est inséré brut.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const payload = await req.json();
    const topic = typeof payload?.topic === "string" ? payload.topic : "";
    const fields = payload?.fields;

    if (!TOPIC_LABELS[topic]) {
      return Response.json({ error: "Unknown topic" }, { status: 400 });
    }
    if (!fields || typeof fields !== "object") {
      return Response.json({ error: "Missing fields" }, { status: 400 });
    }

    const rows = Object.entries(fields as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string" && v.trim().length > 0)
      .map(([k, v]) => {
        const label = escapeHtml(FIELD_LABELS[k] ?? k);
        const value = escapeHtml(String(v)).replace(/\n/g, "<br>");
        return `<tr><td style="padding:8px 0;color:#666;width:150px;vertical-align:top;">${label}</td><td style="padding:8px 0;font-weight:600;">${value}</td></tr>`;
      })
      .join("");

    const title = escapeHtml(TOPIC_LABELS[topic]);
    // Nom du visiteur pour le sujet : pas d'échappement HTML (ce n'est pas du HTML),
    // nettoyage des caractères de contrôle pour défense en profondeur
    const subjectName = (
      typeof (fields as Record<string, unknown>).name === "string"
        ? String((fields as Record<string, unknown>).name)
        : ""
    ).replace(/[\r\n\x00-\x1f]/g, "");

    const htmlBody = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a2e;">
  <div style="background: linear-gradient(135deg, #3f8ca2 0%, #1a1a2e 100%); padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: #fff; margin: 0; font-size: 20px;">${title}</h1>
  </div>
  <div style="border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 12px 12px; padding: 24px;">
    <table style="width: 100%; border-collapse: collapse; margin: 0;">${rows}</table>
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
      secure: false, // STARTTLS sur le port 587
      auth: { user: SMTP_USER, pass: smtpPass },
    });

    const info = await transporter.sendMail({
      from: SMTP_FROM,
      to: ADMIN_EMAIL,
      subject: `[AeroX] ${TOPIC_LABELS[topic]}${subjectName ? ` — ${subjectName}` : ""}`,
      html: htmlBody,
    });

    console.log("Email sent:", info.messageId);
    return Response.json({ message: "Notification sent", messageId: info.messageId }, { status: 200 });
  } catch (error) {
    console.error("notify-admin-lead error:", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
});
