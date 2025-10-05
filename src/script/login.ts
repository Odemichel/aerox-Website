import { supabase } from '~/config/supabaseClient';

export function initLogin() {
  const form = document.getElementById('login-form') as HTMLFormElement | null;
  const message = document.getElementById('message') as HTMLParagraphElement | null;

  function showMessage(text: string, isError = true) {
    if (!message) return;
    message.textContent = text;
    message.classList.remove('text-red-600', 'text-green-600');
    message.classList.add(isError ? 'text-red-600' : 'text-green-600');
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const email = (document.getElementById('email') as HTMLInputElement)?.value.trim() ?? '';
      const password = (document.getElementById('password') as HTMLInputElement)?.value.trim() ?? '';

      if (!email || !password) {
        showMessage('❌ Merci de remplir tous les champs.');
        return;
      }

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });

      if (error || !data?.user) {
        showMessage('❌ Identifiants incorrects ou compte inexistant.');
        return;
      }

      showMessage('✅ Connexion réussie !', false);
      window.location.href = '/inscription/dashboard';
    });
  }
}
