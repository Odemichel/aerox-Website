import { describe, it, expect } from 'vitest';
import { BF_AVAILABLE_AT, LAUNCH_OFFER, LOOKUP } from '../src/lib/billing/catalog';
import { NEXT_RELEASE } from '../src/config/downloads';
import {
  DEFAULT_OFFER,
  suggestUpgrade,
  trialEnd,
  graceAfterPaymentFailureEnd,
  isDowngrade,
  isOffer,
  launchOfferOpen,
  nextInvoiceCentsForOffer,
  offerFromLookupKeys,
  planAfterSubscriptionEnds,
  planFromLookupKeys,
  subscriptionOutcome,
  subscriptionStart,
} from '../src/lib/billing/logic';

const NOW = Date.UTC(2026, 9, 1, 12);

describe('offres', () => {
  it('reconnaît les offres, rien d’autre', () => {
    expect(isOffer('essential')).toBe(true);
    expect(isOffer('unlimited_annual')).toBe(true);
    // Grille du 24/09/2026, jamais vendue : plus proposée.
    expect(isOffer('studio')).toBe(false);
    expect(isOffer('payg')).toBe(false);
    expect(isOffer('pack')).toBe(false);
    expect(isOffer('legacy')).toBe(false);
    expect(isOffer('__proto__')).toBe(false);
    expect(isOffer(undefined)).toBe(false);
  });

  it('monter est immédiat, descendre attend la fin de période', () => {
    expect(isDowngrade('unlimited', 'essential')).toBe(true);
    expect(isDowngrade('unlimited_annual', 'unlimited')).toBe(true);
    expect(isDowngrade('essential', 'unlimited')).toBe(false);
    expect(isDowngrade('essential', 'unlimited_launch')).toBe(false);
  });

  it('offre par défaut de l’essai : Essentiel', () => {
    expect(DEFAULT_OFFER).toBe('essential');
  });
});

describe('offre de lancement', () => {
  it('ouverte tant qu’il reste des places avant la bascule', () => {
    expect(launchOfferOpen(NOW, 1)).toBe(true);
    expect(launchOfferOpen(NOW, 0)).toBe(false);
  });

  it('fermée au 01/01/2027 00:00 heure de Paris', () => {
    expect(new Date(LAUNCH_OFFER.switchAt).toISOString()).toBe('2026-12-31T23:00:00.000Z');
    expect(launchOfferOpen(LAUNCH_OFFER.switchAt - 1, 5)).toBe(true);
    expect(launchOfferOpen(LAUNCH_OFFER.switchAt, 5)).toBe(false);
  });
});

describe('planFromLookupKeys', () => {
  it('déduit le plan des prix de l’abonnement', () => {
    expect(planFromLookupKeys([LOOKUP.essentialBase, LOOKUP.essentialUsage])).toBe('essential');
    expect(planFromLookupKeys([LOOKUP.unlimited])).toBe('unlimited');
    expect(planFromLookupKeys([LOOKUP.unlimitedLaunch])).toBe('unlimited_launch');
    expect(planFromLookupKeys([LOOKUP.unlimitedYear])).toBe('unlimited');
    expect(offerFromLookupKeys([LOOKUP.unlimitedYear])).toBe('unlimited_annual');
    expect(offerFromLookupKeys([LOOKUP.essentialBase, LOOKUP.essentialUsage])).toBe('essential');
  });

  it('ignore un abonnement étranger (Founding Partner)', () => {
    expect(planFromLookupKeys([null, 'founding_partner_usd'])).toBeNull();
    expect(planFromLookupKeys([])).toBeNull();
  });
});

describe('subscriptionOutcome', () => {
  it('actif : accès complet, grâce effacée', () => {
    expect(subscriptionOutcome('active', '2026-10-05T00:00:00.000Z', NOW)).toEqual({
      kind: 'access',
      status: 'active',
      grace_until: null,
    });
  });

  it('premier échec : 7 jours de grâce', () => {
    expect(subscriptionOutcome('past_due', null, NOW)).toEqual({
      kind: 'access',
      status: 'past_due',
      grace_until: '2026-10-08T12:00:00.000Z',
    });
  });

  it('échecs suivants : la date de fin de grâce ne recule pas', () => {
    const first = '2026-10-03T00:00:00.000Z';
    expect(subscriptionOutcome('unpaid', first, NOW)).toMatchObject({ grace_until: first });
  });

  it('résilié : fin d’abonnement ; incomplet : rien n’est ouvert', () => {
    expect(subscriptionOutcome('canceled', null, NOW)).toEqual({ kind: 'ended' });
    expect(subscriptionOutcome('incomplete_expired', null, NOW)).toEqual({ kind: 'ended' });
    expect(subscriptionOutcome('incomplete', null, NOW)).toEqual({ kind: 'ignore' });
  });
});

describe('graceAfterPaymentFailureEnd', () => {
  it('résiliation pour impayé pendant la grâce : accès gardé jusqu’à la fin de la grâce', () => {
    const grace = '2026-10-05T00:00:00.000Z';
    expect(graceAfterPaymentFailureEnd('payment_failed', grace, NOW)).toBe(grace);
  });

  it('pas de grâce enregistrée : 7 jours à partir de maintenant', () => {
    expect(graceAfterPaymentFailureEnd('payment_failed', null, NOW)).toBe('2026-10-08T12:00:00.000Z');
  });

  it('grâce déjà écoulée, ou résiliation demandée : fin normale', () => {
    expect(graceAfterPaymentFailureEnd('payment_failed', '2026-09-30T00:00:00.000Z', NOW)).toBeNull();
    expect(graceAfterPaymentFailureEnd('cancellation_requested', '2026-10-05T00:00:00.000Z', NOW)).toBeNull();
    expect(graceAfterPaymentFailureEnd(null, null, NOW)).toBeNull();
  });
});

describe('subscriptionStart', () => {
  const anchor = BF_AVAILABLE_AT / 1000;
  const DAY = 86_400_000;

  it('premier abonnement : 14 jours d’essai comptés à partir de la sortie de l’application', () => {
    const fromRelease = Math.floor((NEXT_RELEASE.opensAt + 14 * DAY) / 1000);
    // Souscrit le 1er octobre, avant la sortie (20 octobre) : 14 jours à partir du 20.
    expect(subscriptionStart(NOW, false, true)).toEqual({ trial_end: fromRelease });
    expect(subscriptionStart(NOW, true, true)).toEqual({ trial_end: fromRelease });
    expect(fromRelease * 1000).toBeGreaterThan(BF_AVAILABLE_AT);
    // Souscrit le 25 octobre, après la sortie : 14 jours, jusqu'au 8 novembre.
    const late = Date.UTC(2026, 9, 25, 10);
    expect(subscriptionStart(late, false, true)).toEqual({ trial_end: Math.floor((late + 14 * DAY) / 1000) });
    const after = BF_AVAILABLE_AT + 10 * DAY;
    expect(trialEnd(after)).toBe(Math.floor((after + 14 * DAY) / 1000));
  });

  it('essai déjà utilisé, annuel : facturation ancrée au 1er novembre, sans prorata', () => {
    expect(subscriptionStart(NOW, true, false)).toEqual({ billing_cycle_anchor: anchor, proration_behavior: 'none' });
  });

  it('essai déjà utilisé, mensuel à moins d’un mois : ancrée aussi', () => {
    expect(subscriptionStart(Date.UTC(2026, 9, 5), false, false)).toEqual({
      billing_cycle_anchor: anchor,
      proration_behavior: 'none',
    });
  });

  it('essai déjà utilisé, mensuel à plus d’un mois : période d’essai Stripe (ancrage refusé)', () => {
    expect(subscriptionStart(Date.UTC(2026, 8, 26), false, false)).toEqual({ trial_end: anchor });
  });

  it('essai déjà utilisé, après la mise à disposition : facturation immédiate', () => {
    expect(subscriptionStart(BF_AVAILABLE_AT + 1, false, false)).toEqual({});
    expect(subscriptionStart(BF_AVAILABLE_AT - 30 * 60 * 1000, true, false)).toEqual({});
  });
});

describe('transitions de plan', () => {
  it('fin d’abonnement : retour à l’essai', () => {
    expect(planAfterSubscriptionEnds()).toBe('trial');
  });
});

describe('nextInvoiceCentsForOffer', () => {
  const est = (
    offer: Parameters<typeof nextInvoiceCentsForOffer>[0],
    n = 0,
    now = NOW,
    end: number | null = null,
    inTrial = false
  ) => nextInvoiceCentsForOffer(offer, n, now, end, inTrial);

  it('Essentiel : 20 € + 15 € par analyse (6 analyses → 110 €)', () => {
    expect(est('essential', 6)).toBe(11000);
    expect(est('essential', 0)).toBe(2000);
  });

  it('Essentiel en essai : analyses gratuites, premier prélèvement 20 €', () => {
    expect(est('essential', 9, NOW, null, true)).toBe(2000);
  });

  it('bascule : Essentiel jusqu’à 5 analyses, Illimité dès 6', () => {
    expect(est('essential', 5)).toBeLessThan(est('unlimited'));
    expect(est('essential', 6)).toBeGreaterThan(est('unlimited'));
  });

  it('Illimité : 99 €/mois ou 990 €/an', () => {
    expect(est('unlimited')).toBe(9900);
    expect(est('unlimited_annual')).toBe(99000);
  });

  it('lancement mensuel : 69 € puis le tarif normal, 99 €', () => {
    expect(est('unlimited_launch')).toBe(6900);
    expect(est('unlimited_launch', 0, NOW, LAUNCH_OFFER.switchAt)).toBe(9900);
  });

  it('lancement annuel : 690 € en fin d’essai, puis le tarif normal, 990 €', () => {
    expect(est('unlimited_launch_annual', 0, NOW, null, true)).toBe(69000);
    expect(est('unlimited_launch_annual', 0, NOW, BF_AVAILABLE_AT + 365 * 86400000)).toBe(99000);
  });
});

describe('suggestUpgrade', () => {
  it('Essentiel à partir de 7 analyses sur la période', () => {
    expect(suggestUpgrade('essential', 6)).toBe(false);
    expect(suggestUpgrade('essential', 7)).toBe(true);
    expect(suggestUpgrade('unlimited', 30)).toBe(false);
    expect(suggestUpgrade(null, 30)).toBe(false);
  });
});

describe('offre de lancement annuelle', () => {
  it('reconnue par ses prix, plan « lancement » (mêmes places)', () => {
    expect(planFromLookupKeys([LOOKUP.unlimitedLaunchYear])).toBe('unlimited_launch');
    expect(offerFromLookupKeys([LOOKUP.unlimitedLaunchYear])).toBe('unlimited_launch_annual');
    expect(isOffer('unlimited_launch_annual')).toBe(true);
  });

  it('la quitter pour un mensuel attend la fin de l’année payée', () => {
    expect(isDowngrade('unlimited_launch_annual', 'unlimited')).toBe(true);
    expect(isDowngrade('unlimited_launch_annual', 'unlimited_launch')).toBe(true);
    expect(isDowngrade('unlimited_launch_annual', 'unlimited_annual')).toBe(false);
  });
});
