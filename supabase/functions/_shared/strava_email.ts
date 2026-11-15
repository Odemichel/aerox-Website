// supabase/functions/_shared/strava_email.ts
//
// Confirmation écrite de la suppression des données Strava (Strava API
// Agreement, Privacy) : envoyée après une déconnexion depuis AeroX comme
// après un retrait d'accès depuis Strava (webhook), dans la langue du
// cycliste. N'interrompt jamais la purge : un échec est seulement logué.
import nodemailer from 'npm:nodemailer@6.9.16';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 587;
const SMTP_USER = 'olivier.demichel@aeroxbefaster.com';
const SMTP_FROM = '"AeroX BeFaster" <no-reply@aeroxbefaster.com>';

interface Texts {
  subject: string;
  title: string;
  body: string;
  remains: string;
  contact: string;
}

const TEXTS: Record<string, Texts> = {
  fr: {
    subject: 'Strava déconnecté : vos données Strava ont été supprimées',
    title: 'Strava est déconnecté de votre compte AeroX',
    body: "Nous avons supprimé toutes les données Strava que nous détenions : l'identifiant de votre compte Strava, les jetons d'accès et les identifiants des activités envoyées depuis AeroX.",
    remains:
      'Les activités déjà envoyées restent sur Strava : vous pouvez les y supprimer. Vos séances AeroX restent dans AeroX.',
    contact: 'Une question ? Répondez à contact@aeroxbefaster.com.',
  },
  en: {
    subject: 'Strava disconnected: your Strava data has been deleted',
    title: 'Strava is disconnected from your AeroX account',
    body: 'We have deleted all the Strava data we held: your Strava account ID, the access tokens and the IDs of the activities sent from AeroX.',
    remains: 'Activities already sent remain on Strava, where you can delete them. Your AeroX sessions stay in AeroX.',
    contact: 'Any question? Write to contact@aeroxbefaster.com.',
  },
  es: {
    subject: 'Strava desconectado: tus datos de Strava se han eliminado',
    title: 'Strava está desconectado de tu cuenta AeroX',
    body: 'Hemos eliminado todos los datos de Strava que teníamos: el identificador de tu cuenta de Strava, los tokens de acceso y los identificadores de las actividades enviadas desde AeroX.',
    remains:
      'Las actividades ya enviadas siguen en Strava, donde puedes eliminarlas. Tus sesiones de AeroX siguen en AeroX.',
    contact: '¿Alguna pregunta? Escribe a contact@aeroxbefaster.com.',
  },
  it: {
    subject: 'Strava scollegato: i tuoi dati Strava sono stati eliminati',
    title: 'Strava è scollegato dal tuo account AeroX',
    body: "Abbiamo eliminato tutti i dati Strava in nostro possesso: l'identificativo del tuo account Strava, i token di accesso e gli identificativi delle attività inviate da AeroX.",
    remains: 'Le attività già inviate restano su Strava, dove puoi eliminarle. Le tue sessioni AeroX restano in AeroX.',
    contact: 'Domande? Scrivi a contact@aeroxbefaster.com.',
  },
  de: {
    subject: 'Strava getrennt: deine Strava-Daten wurden gelöscht',
    title: 'Strava ist von deinem AeroX-Konto getrennt',
    body: 'Wir haben alle Strava-Daten gelöscht, die wir gespeichert hatten: die ID deines Strava-Kontos, die Zugriffstoken und die IDs der von AeroX gesendeten Aktivitäten.',
    remains:
      'Bereits gesendete Aktivitäten bleiben auf Strava, wo du sie löschen kannst. Deine AeroX-Einheiten bleiben in AeroX.',
    contact: 'Fragen? Schreib an contact@aeroxbefaster.com.',
  },
  nl: {
    subject: 'Strava ontkoppeld: je Strava-gegevens zijn verwijderd',
    title: 'Strava is ontkoppeld van je AeroX-account',
    body: 'We hebben alle Strava-gegevens verwijderd die we bewaarden: de ID van je Strava-account, de toegangstokens en de ID’s van de activiteiten die vanuit AeroX zijn verzonden.',
    remains:
      'Al verzonden activiteiten blijven op Strava staan, waar je ze kunt verwijderen. Je AeroX-sessies blijven in AeroX.',
    contact: 'Vragen? Schrijf naar contact@aeroxbefaster.com.',
  },
  pt: {
    subject: 'Strava desconectado: seus dados do Strava foram excluídos',
    title: 'O Strava foi desconectado da sua conta AeroX',
    body: 'Excluímos todos os dados do Strava que tínhamos: o identificador da sua conta Strava, os tokens de acesso e os identificadores das atividades enviadas pelo AeroX.',
    remains:
      'As atividades já enviadas continuam no Strava, onde você pode excluí-las. Suas sessões AeroX continuam no AeroX.',
    contact: 'Dúvidas? Escreva para contact@aeroxbefaster.com.',
  },
  ja: {
    subject: 'Strava連携を解除しました：Stravaのデータを削除しました',
    title: 'AeroXアカウントとStravaの連携が解除されました',
    body: '保有していたStravaのデータ（StravaアカウントID、アクセストークン、AeroXから送信したアクティビティのID）をすべて削除しました。',
    remains: '送信済みのアクティビティはStravaに残ります。Stravaで削除できます。AeroXのセッションはAeroXに残ります。',
    contact: 'ご質問は contact@aeroxbefaster.com まで。',
  },
  tr: {
    subject: 'Strava bağlantısı kesildi: Strava verilerin silindi',
    title: 'Strava, AeroX hesabından ayrıldı',
    body: "Sakladığımız tüm Strava verilerini sildik: Strava hesap kimliğin, erişim belirteçleri ve AeroX'ten gönderilen aktivitelerin kimlikleri.",
    remains: "Gönderilmiş aktiviteler Strava'da kalır, oradan silebilirsin. AeroX seansların AeroX'te kalır.",
    contact: 'Sorun mu var? contact@aeroxbefaster.com adresine yaz.',
  },
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** E-mail de confirmation de la suppression des données Strava. */
export async function sendStravaDeletionEmail(db: SupabaseClient, userId: string): Promise<void> {
  try {
    const smtpPass = Deno.env.get('SMTP_PASS');
    if (!smtpPass) throw new Error('SMTP_PASS manquant');
    const [{ data: auth }, { data: profile }] = await Promise.all([
      db.auth.admin.getUserById(userId),
      db.from('users').select('lang').eq('id', userId).maybeSingle<{ lang: string | null }>(),
    ]);
    const to = auth?.user?.email;
    if (!to) throw new Error('adresse e-mail introuvable');
    const t = TEXTS[profile?.lang ?? ''] ?? TEXTS.en;
    const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#002032;font-family:Arial,sans-serif;color:#ffffff;">
  <div style="max-width:560px;margin:0 auto;">
    <h2 style="color:#F2A32B;">${escapeHtml(t.title)}</h2>
    <p>${escapeHtml(t.body)}</p>
    <p>${escapeHtml(t.remains)}</p>
    <hr style="border:none;border-top:1px solid #004466;margin:24px 0;">
    <p style="color:#8899aa;font-size:13px;">${escapeHtml(t.contact)}</p>
  </div>
</body></html>`;
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false, // STARTTLS sur le port 587
      auth: { user: SMTP_USER, pass: smtpPass },
    });
    await transporter.sendMail({ from: SMTP_FROM, to, subject: t.subject, html });
    console.info('strava : confirmation de suppression envoyée');
  } catch (e) {
    console.error('strava : confirmation de suppression non envoyée', (e as Error).message);
  }
}
