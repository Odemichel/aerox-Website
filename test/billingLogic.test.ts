import { describe, it, expect } from 'vitest';
import { BF_AVAILABLE_AT, LAUNCH_OFFER, LOOKUP } from '../src/lib/billing/catalog';
import {
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
    expect(isOffer('studio')).toBe(true);
    expect(isOffer('payg')).toBe(true);
    expect(isOffer('unlimited_annual')).toBe(true);
    expect(isOffer('pack')).toBe(false);
    expect(isOffer('legacy')).toBe(false);
    expect(isOffer('__proto__')).toBe(false);
    expect(isOffer(undefined)).toBe(false);
  });

  it('monter est immédiat, descendre attend la fin de période', () => {
    expect(isDowngrade('unlimited', 'studio')).toBe(true);
    expect(isDowngrade('unlimited_annual', 'unlimited')).toBe(true);
    expect(isDowngrade('studio', 'payg')).toBe(true);
    expect(isDowngrade('payg', 'studio')).toBe(false);
    expect(isDowngrade('studio', 'unlimited_launch')).toBe(false);
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
    expect(planFromLookupKeys([LOOKUP.studioBase, LOOKUP.studioUsage])).toBe('studio');
    expect(planFromLookupKeys([LOOKUP.unlimited])).toBe('unlimited');
    expect(planFromLookupKeys([LOOKUP.unlimitedLaunch])).toBe('unlimited_launch');
    expect(planFromLookupKeys([LOOKUP.unlimitedLaunchAfter])).toBe('unlimited_launch');
    expect(planFromLookupKeys([LOOKUP.unlimitedYear])).toBe('unlimited');
    expect(planFromLookupKeys([LOOKUP.payg])).toBe('payg');
    expect(offerFromLookupKeys([LOOKUP.unlimitedYear])).toBe('unlimited_annual');
    expect(offerFromLookupKeys([LOOKUP.studioBase, LOOKUP.studioUsage])).toBe('studio');
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
  it('annuel : facturation ancrée au 1er novembre, sans prorata', () => {
    expect(subscriptionStart(NOW, true)).toEqual({ billing_cycle_anchor: anchor, proration_behavior: 'none' });
  });

  it('mensuel à moins d’un mois : ancrée aussi', () => {
    expect(subscriptionStart(Date.UTC(2026, 9, 5), false)).toEqual({
      billing_cycle_anchor: anchor,
      proration_behavior: 'none',
    });
  });

  it('mensuel à plus d’un mois : période d’essai Stripe (ancrage refusé par Stripe)', () => {
    expect(subscriptionStart(Date.UTC(2026, 8, 26), false)).toEqual({ trial_end: anchor });
  });

  it('après la mise à disposition : facturation immédiate', () => {
    expect(subscriptionStart(BF_AVAILABLE_AT + 1, false)).toEqual({});
    expect(subscriptionStart(BF_AVAILABLE_AT - 30 * 60 * 1000, true)).toEqual({});
  });
});

describe('transitions de plan', () => {
  it('fin d’abonnement : retour à l’essai', () => {
    expect(planAfterSubscriptionEnds()).toBe('trial');
  });
});

describe('nextInvoiceCentsForOffer', () => {
  const est = (offer: Parameters<typeof nextInvoiceCentsForOffer>[0], n = 0, now = NOW, end: number | null = null) =>
    nextInvoiceCentsForOffer(offer, n, now, end);

  it('À l’usage : 20 € par analyse', () => {
    expect(est('payg', 3)).toBe(6000);
  });

  it('Studio : 79 € + 10 € par analyse au-delà de 5 (14 analyses → 169 €)', () => {
    expect(est('studio', 14)).toBe(16900);
    expect(est('studio', 3)).toBe(7900);
  });

  it('paliers : usage < 4, Studio de 4 à 9, Illimité dès 10', () => {
    expect(est('payg', 3)).toBeLessThan(est('studio', 3));
    expect(est('studio', 4)).toBeLessThan(est('payg', 4));
    expect(est('studio', 10)).toBeGreaterThan(11900);
  });

  it('Illimité : 119 €/mois ou 1 190 €/an', () => {
    expect(est('unlimited')).toBe(11900);
    expect(est('unlimited_annual')).toBe(119000);
  });

  it('lancement mensuel : 69 € puis le tarif normal, 119 €', () => {
    expect(est('unlimited_launch')).toBe(6900);
    expect(est('unlimited_launch', 0, LAUNCH_OFFER.switchAt)).toBe(11900);
  });

  it('lancement annuel : 690 € la 1re année, puis le tarif normal, 1 190 €', () => {
    expect(est('unlimited_launch_annual', 0, NOW, BF_AVAILABLE_AT)).toBe(69000);
    expect(est('unlimited_launch_annual', 0, NOW, BF_AVAILABLE_AT + 365 * 86400000)).toBe(119000);
  });
});

describe('offre de lancement annuelle', () => {
  it('reconnue par ses prix, plan « lancement » (mêmes places)', () => {
    expect(planFromLookupKeys([LOOKUP.unlimitedLaunchYear])).toBe('unlimited_launch');
    expect(planFromLookupKeys([LOOKUP.unlimitedLaunchYearAfter])).toBe('unlimited_launch');
    expect(offerFromLookupKeys([LOOKUP.unlimitedLaunchYear])).toBe('unlimited_launch_annual');
    expect(offerFromLookupKeys([LOOKUP.unlimitedLaunchYearAfter])).toBe('unlimited_launch_annual');
    expect(isOffer('unlimited_launch_annual')).toBe(true);
  });

  it('la quitter pour un mensuel attend la fin de l’année payée', () => {
    expect(isDowngrade('unlimited_launch_annual', 'unlimited')).toBe(true);
    expect(isDowngrade('unlimited_launch_annual', 'unlimited_launch')).toBe(true);
    expect(isDowngrade('unlimited_launch_annual', 'unlimited_annual')).toBe(false);
  });
});
