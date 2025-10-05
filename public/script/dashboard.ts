import { supabase } from "../../src/config/supabaseClient";

console.log("Dashboard script chargé ✅");

export async function initDashboard() {
  const message = document.getElementById('message');

  try {
    const { data: userData, error: authError } = await supabase.auth.getUser();
    console.log("➡️ Résultat getUser:", { userData, authError });

    if (!userData?.user) {
      if (message) message.textContent = "❌ Pas connecté.";
      return;
    }

    console.log("✅ Utilisateur:", userData.user);

    const { data: profile, error: selectError } = await supabase
      .from('users')
      .select('role, is_active, licence_type')
      .eq('id', userData.user.id)
      .maybeSingle();

    console.log("➡️ Résultat select profile:", { profile, selectError });

    if (selectError) {
      console.error("❌ Erreur select profile:", selectError);
      if (message) message.textContent = "Erreur chargement profil.";
      return;
    }

    if (profile) {
      if (message) message.textContent = `✅ Abonnement trouvé: ${profile.licence_type}`;
    } else {
      if (message) message.textContent = "⚠️ Aucun abonnement trouvé.";
    }
  } catch (err) {
    console.error("❌ Erreur Dashboard script:", err);
    if (message) message.textContent = "Erreur interne.";
  }
}
