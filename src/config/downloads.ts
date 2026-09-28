// src/config/downloads.ts
//
// Liens de téléchargement de l'application desktop, partagés par la page de
// téléchargement, l'espace compte et l'onboarding bike fitter. Un seul endroit
// à changer à chaque nouvelle version : les liens ET `version`.
export const DOWNLOADS = {
  version: '1.0.0',
  mac: 'https://github.com/Odemichel/AeroX-release/releases/download/MacOs_V1.0.0/AeroX.zip',
  windows: 'https://github.com/Odemichel/AeroX-release/releases/download/WindowsV1.0.0/AeroX.zip',
};

// Téléchargements suspendus jusqu'à la nouvelle version (décision du
// 2026-09-28) : message d'attente à la place des boutons. Ils rouvrent seuls
// quand la date est passée ET que les liens ci-dessus pointent sur une version
// au moins égale à `minVersion` (même seuil que `version.min_required` en
// base) : une sortie en retard ne rouvre jamais l'ancienne version.
export const NEXT_RELEASE = {
  opensAt: Date.UTC(2026, 9, 19, 22, 0, 0), // 20/10/2026 00:00, Paris
  minVersion: '1.4.0',
};

// Groupes MailerLite des personnes à prévenir de la sortie (FR, autres langues).
export const RELEASE_NOTIFY_GROUPS = { fr: '199838856502051867', en: '199838857645000382' };

/** Compare deux versions « x.y.z » : négatif, zéro ou positif. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Les liens publiés sont-ils ceux de la nouvelle version ? */
export const releaseLinksReady = () => compareVersions(DOWNLOADS.version, NEXT_RELEASE.minVersion) >= 0;

/** Téléchargements ouverts à cet instant ? */
export const downloadsOpen = (nowMs: number) => nowMs >= NEXT_RELEASE.opensAt && releaseLinksReady();

// Vidéo de calibration montrée à l'onboarding bike fitter. Vide = bouton masqué
// (aucune vidéo publiée à ce jour).
export const CALIBRATION_VIDEO_URL = '';
