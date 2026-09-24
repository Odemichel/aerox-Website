import { describe, it, expect } from 'vitest';
import { LAUNCH_OFFER, LOOKUP } from '../src/lib/billing/catalog';
import {
  estimatedNextInvoiceCents,
  isOffer,
  launchOfferOpen,
  packExpiry,
  planAfterPackPurchase,
  planAfterSubscriptionEnds,
  planFromLookupKeys,
  subscriptionOutcome,
} from '../src/lib/billing/logic';

const NOW = Date.UTC(2026, 9, 1, 12);

describe('offres', () => {
  it('reconnaît les offres, rien d’autre', () => {
    expect(isOffer('studio')).toBe(true);
    expect(isOffer('legacy')).toBe(false);
    expect(isOffer('__proto__')).toBe(false);
    expect(isOffer(undefined)).toBe(false);
  });

  it('pack valable 12 mois', () => {
    expect(packExpiry(NOW).toISOString()).toBe('2027-10-01T12:00:00.000Z');
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

describe('transitions de plan', () => {
  it('fin d’abonnement : retour au pack s’il reste des crédits', () => {
    expect(planAfterSubscriptionEnds(true)).toBe('pack');
    expect(planAfterSubscriptionEnds(false)).toBe('trial');
  });

  it('achat d’un pack : un abonné garde son offre', () => {
    expect(planAfterPackPurchase('trial')).toBe('pack');
    expect(planAfterPackPurchase(null)).toBe('pack');
    expect(planAfterPackPurchase('studio')).toBe('studio');
    expect(planAfterPackPurchase('legacy')).toBe('legacy');
  });
});

describe('estimatedNextInvoiceCents', () => {
  it('Studio : 69 € + 8 € par analyse au-delà de 10 (14 analyses → 101 €)', () => {
    expect(estimatedNextInvoiceCents('studio', 14, NOW)).toBe(10100);
    expect(estimatedNextInvoiceCents('studio', 3, NOW)).toBe(6900);
  });

  it('lancement : 69 € puis 99 €', () => {
    expect(estimatedNextInvoiceCents('unlimited_launch', 0, NOW)).toBe(6900);
    expect(estimatedNextInvoiceCents('unlimited_launch', 0, LAUNCH_OFFER.switchAt)).toBe(9900);
  });

  it('pas de facture pour l’essai, le pack ou legacy', () => {
    expect(estimatedNextInvoiceCents('pack', 5, NOW)).toBeNull();
    expect(estimatedNextInvoiceCents('legacy', 5, NOW)).toBeNull();
  });
});
