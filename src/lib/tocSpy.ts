// src/lib/tocSpy.ts
//
// Sommaire collant : la section en cours de lecture est mise en évidence au
// fil du défilement. Les liens portent `data-toc-link="<id de la section>"` ;
// le conteneur `data-toc` porte les classes de mise en évidence dans
// `data-toc-active` (séparées par des espaces), pour que chaque page choisisse
// sa couleur (articles : jaune ; /cda : orange). Les classes doivent figurer
// en clair dans le fichier .astro de la page pour que Tailwind les génère.

export function initTocSpy() {
  document.querySelectorAll<HTMLElement>('[data-toc]').forEach((toc) => {
    if (toc.dataset.bound === '1') return;
    toc.dataset.bound = '1';
    const active = (toc.dataset.tocActive ?? '').split(/\s+/).filter(Boolean);
    const links = [...toc.querySelectorAll<HTMLAnchorElement>('[data-toc-link]')];
    const sections = links
      .map((a) => document.getElementById(a.dataset.tocLink ?? ''))
      .filter((h): h is HTMLElement => h !== null);
    let current: string | null = null;
    let ticking = false;
    const update = () => {
      ticking = false;
      // Dernière section dont le titre est passé sous le haut d'écran collant.
      let id = '';
      for (const h of sections) if (h.getBoundingClientRect().top <= 160) id = h.id;
      if (id === current) return;
      current = id;
      links.forEach((a) => active.forEach((c) => a.classList.toggle(c, a.dataset.tocLink === id)));
    };
    window.addEventListener(
      'scroll',
      () => {
        if (!ticking) {
          ticking = true;
          requestAnimationFrame(update);
        }
      },
      { passive: true }
    );
    update();
  });
}
