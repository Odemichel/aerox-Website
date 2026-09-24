import { describe, it, expect } from 'vitest';
import type Stripe from 'stripe';
import { purchaseFromSession, refundFromCharge } from '../src/lib/diagnostic/purchase';

const NOW = new Date(Date.UTC(2026, 9, 1, 12));

const session = (over: Partial<Stripe.Checkout.Session> = {}) =>
  ({
    id: 'cs_1',
    payment_status: 'paid',
    payment_intent: 'pi_1',
    amount_total: 4900,
    currency: 'eur',
    metadata: { userId: 'u1', product: 'diagnostic' },
    consent: { terms_of_service: 'accepted', promotions: null },
    ...over,
  }) as Stripe.Checkout.Session;

describe('achat du diagnostic', () => {
  it('enregistre une session payée, avec la renonciation au droit de rétractation', () => {
    expect(purchaseFromSession(session(), NOW)).toEqual({
      user_id: 'u1',
      stripe_checkout_session_id: 'cs_1',
      stripe_payment_intent_id: 'pi_1',
      amount_total: 4900,
      currency: 'eur',
      paid_at: '2026-10-01T12:00:00.000Z',
      withdrawal_waiver_at: '2026-10-01T12:00:00.000Z',
    });
  });

  it('ne trace pas de renonciation que le rider n’a pas cochée', () => {
    expect(purchaseFromSession(session({ consent: null }), NOW)?.withdrawal_waiver_at).toBeNull();
  });

  it('lit le PaymentIntent qu’il soit développé ou non', () => {
    const expanded = session({ payment_intent: { id: 'pi_2' } as Stripe.PaymentIntent });
    expect(purchaseFromSession(expanded, NOW)?.stripe_payment_intent_id).toBe('pi_2');
  });

  it('ignore un paiement pas encore abouti', () => {
    expect(purchaseFromSession(session({ payment_status: 'unpaid' }), NOW)).toBeNull();
  });

  it('ignore le livre : un userId sans product ne débloque rien', () => {
    expect(purchaseFromSession(session({ metadata: { userId: 'u1' } }), NOW)).toBeNull();
  });

  it('ignore un autre produit et une session sans rider', () => {
    expect(purchaseFromSession(session({ metadata: { userId: 'u1', product: 'livre' } }), NOW)).toBeNull();
    expect(purchaseFromSession(session({ metadata: { product: 'diagnostic' } }), NOW)).toBeNull();
    expect(purchaseFromSession(session({ metadata: null }), NOW)).toBeNull();
  });
});

describe('remboursement', () => {
  const charge = (over: Partial<Stripe.Charge> = {}) =>
    ({ id: 'ch_1', payment_intent: 'pi_1', amount_refunded: 4900, refunded: true, ...over }) as Stripe.Charge;

  it('rattache le remboursement total au PaymentIntent', () => {
    expect(refundFromCharge(charge())).toEqual({ paymentIntentId: 'pi_1', amountRefunded: 4900, fullyRefunded: true });
  });

  it('distingue un remboursement partiel', () => {
    expect(refundFromCharge(charge({ amount_refunded: 1000, refunded: false }))?.fullyRefunded).toBe(false);
  });

  it('ignore une charge sans PaymentIntent', () => {
    expect(refundFromCharge(charge({ payment_intent: null }))).toBeNull();
  });
});
