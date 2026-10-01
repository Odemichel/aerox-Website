// src/lib/guideCaptureForm.ts
//
// Formulaires « livre offert » (`form[data-guide-capture]`) : envoi vers
// /{lang}/telechargement/api/subscribe-livre/. Partagé par GuideCapture et
// PostConversion.

// Attache en deux temps, et idempotente :
//  - appel à la racine du script -> couvre le premier rendu. `astro:page-load`
//    ne suffit pas : il est câblé sur le `load` de window (voir
//    astro/dist/transitions/router.js), donc il attend toutes les
//    sous-ressources de la page (scripts tiers différés, images, vidéos) —
//    plusieurs secondes pendant lesquelles aucun `preventDefault` ne serait
//    posé et où ClientRouter récupérerait la soumission ;
//  - écouteur `astro:page-load` -> couvre les navigations ClientRouter, un
//    script module ne se ré-exécutant jamais après sa première exécution
//    dans la session (cache `scriptsAlreadyRan` d'Astro).
// Le marqueur `dataset.leadFormBound` rend le double appel sans effet : un
// formulaire déjà lié n'est jamais ré-attaché.
export function initGuideCaptureForms() {
  document.querySelectorAll<HTMLFormElement>('form[data-guide-capture]').forEach((form) => {
    if (form.dataset.leadFormBound === '1') return;
    form.dataset.leadFormBound = '1';
    const msg = form.parentElement?.querySelector<HTMLElement>('[data-guide-msg]');

    const show = (ok: boolean) => {
      if (!msg) return;
      msg.textContent = (ok ? form.dataset.success : form.dataset.error) ?? '';
      msg.classList.remove('hidden', 'text-red-600', 'text-green-600');
      msg.classList.add(ok ? 'text-green-600' : 'text-red-600');
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = (form.elements.namedItem('email') as HTMLInputElement).value.trim();
      const hp = (form.elements.namedItem('hp') as HTMLInputElement | null)?.value ?? '';
      const lang = window.location.pathname.split('/')[1] || 'fr';
      try {
        const res = await fetch(`/${lang}/telechargement/api/subscribe-livre/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Origine du formulaire (data-source), transmise à MailerLite.
          body: JSON.stringify({ email, hp, source: form.dataset.source ?? '' }),
        });
        const data = await res.json();
        show(Boolean(data.success));
        if (data.success) form.reset();
      } catch {
        show(false);
      }
    });
  });
}
