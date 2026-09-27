import { describe, it, expect } from 'vitest';
import {
  LOOKUP,
  PRICES,
  PRODUCTS,
  RETIRED_LOOKUP_KEYS,
  RETIRED_PRODUCT_KEYS,
  TRIAL_DAYS,
  UPGRADE_HINT_AT,
  priceDiffs,
  type ExistingPrice,
  type PriceSpec,
} from '../src/lib/billing/catalog';

const spec = (lookup: string) => PRICES.find((p) => p.lookup_key === lookup)!;

// Prix à paliers : plus dans la grille, mais `priceDiffs` sait toujours les comparer.
const tieredSpec: PriceSpec = {
  lookup_key: 'test_tiered',
  product: 'bf_essential_usage',
  nickname: 'test',
  currency: 'eur',
  tax_behavior: 'exclusive',
  recurring: { interval: 'month', usage_type: 'metered' },
  metered: true,
  tiers: [
    { up_to: 5, unit_amount: 0 },
    { up_to: 'inf', unit_amount: 1000 },
  ],
};

const unitPrice = (over: Partial<ExistingPrice> = {}): ExistingPrice => ({
  product: 'prod_essential',
  currency: 'eur',
  unit_amount: 2000,
  tax_behavior: 'exclusive',
  billing_scheme: 'per_unit',
  tiers_mode: null,
  tiers: null,
  recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed', meter: null },
  ...over,
});

const meteredPrice = (over: Partial<ExistingPrice> = {}): ExistingPrice => ({
  product: 'prod_usage',
  currency: 'eur',
  unit_amount: 1500,
  tax_behavior: 'exclusive',
  billing_scheme: 'per_unit',
  tiers_mode: null,
  tiers: null,
  recurring: { interval: 'month', interval_count: 1, usage_type: 'metered', meter: 'mtr_1' },
  ...over,
});

const tieredPrice = (over: Partial<ExistingPrice> = {}): ExistingPrice => ({
  ...meteredPrice(),
  unit_amount: null,
  billing_scheme: 'tiered',
  tiers_mode: 'graduated',
  tiers: [
    { up_to: 5, unit_amount: 0, flat_amount: null },
    { up_to: null, unit_amount: 1000, flat_amount: null },
  ],
  ...over,
});

describe('catalogue bike fitter', () => {
  it('donne un produit connu à chaque prix et des lookup_key uniques', () => {
    const keys = new Set(PRODUCTS.map((p) => p.key));
    for (const p of PRICES) expect(keys.has(p.product)).toBe(true);
    expect(new Set(PRICES.map((p) => p.lookup_key)).size).toBe(PRICES.length);
  });

  it('respecte la grille tarifaire (HT, EUR)', () => {
    expect(spec(LOOKUP.essentialBase)).toMatchObject({ unit_amount: 2000 });
    expect(spec(LOOKUP.essentialBase).recurring).toEqual({ interval: 'month', usage_type: 'licensed' });
    expect(spec(LOOKUP.essentialUsage)).toMatchObject({ unit_amount: 1500, metered: true });
    expect(spec(LOOKUP.essentialUsage).recurring).toEqual({ interval: 'month', usage_type: 'metered' });
    expect(spec(LOOKUP.unlimited)).toMatchObject({ unit_amount: 9900 });
    expect(spec(LOOKUP.unlimitedYear)).toMatchObject({ unit_amount: 99000 });
    expect(spec(LOOKUP.unlimitedYear).recurring?.interval).toBe('year');
    expect(spec(LOOKUP.unlimitedLaunch)).toMatchObject({ unit_amount: 6900 });
    expect(spec(LOOKUP.unlimitedLaunchYear)).toMatchObject({ unit_amount: 69000 });
    expect(spec(LOOKUP.unlimitedLaunchYear).recurring?.interval).toBe('year');
    for (const p of PRICES) expect(p).toMatchObject({ currency: 'eur', tax_behavior: 'exclusive' });
  });

  it('bascule Essentiel → Illimité : 7 analyses (20 + 15 × 7 = 125 € > 99 €)', () => {
    expect(UPGRADE_HINT_AT).toBe(7);
    expect(2000 + 1500 * UPGRADE_HINT_AT).toBeGreaterThan(9900);
    expect(TRIAL_DAYS).toBe(14);
  });

  it('Pack, À l’usage et Studio sont retirés de la grille', () => {
    for (const key of ['aerox_bf_pack10', 'aerox_bf_payg', 'aerox_bf_studio_base', 'aerox_bf_studio_usage']) {
      expect(PRICES.some((p) => p.lookup_key === key)).toBe(false);
      expect(RETIRED_LOOKUP_KEYS).toContain(key);
    }
    expect(RETIRED_PRODUCT_KEYS).toEqual(
      expect.arrayContaining(['bf_pack', 'bf_payg', 'bf_studio', 'bf_studio_usage'])
    );
  });
});

describe('priceDiffs', () => {
  it('ne signale rien sur un prix conforme', () => {
    expect(priceDiffs(unitPrice(), spec(LOOKUP.essentialBase), 'prod_essential')).toEqual([]);
    expect(priceDiffs(meteredPrice(), spec(LOOKUP.essentialUsage), 'prod_usage', 'mtr_1')).toEqual([]);
    expect(priceDiffs(tieredPrice(), tieredSpec, 'prod_usage', 'mtr_1')).toEqual([]);
  });

  it('accepte un produit développé (expand)', () => {
    expect(
      priceDiffs(unitPrice({ product: { id: 'prod_essential' } }), spec(LOOKUP.essentialBase), 'prod_essential')
    ).toEqual([]);
  });

  it('détecte un changement de montant ou de TVA (Illimité 119 € → 99 €)', () => {
    expect(priceDiffs(unitPrice({ unit_amount: 11900 }), spec(LOOKUP.unlimited), 'prod_essential')).toEqual([
      'unit_amount',
    ]);
    expect(priceDiffs(unitPrice({ tax_behavior: 'inclusive' }), spec(LOOKUP.essentialBase), 'prod_essential')).toEqual([
      'tax_behavior',
    ]);
  });

  it('détecte un changement de rythme (mois → an)', () => {
    expect(priceDiffs(unitPrice({ unit_amount: 99000 }), spec(LOOKUP.unlimitedYear), 'prod_essential')).toEqual([
      'recurring.interval',
    ]);
  });

  it('détecte des paliers modifiés ou un meter différent', () => {
    const tiers = [
      { up_to: 5, unit_amount: 0, flat_amount: null },
      { up_to: null, unit_amount: 800, flat_amount: null },
    ];
    expect(priceDiffs(tieredPrice({ tiers }), tieredSpec, 'prod_usage', 'mtr_1')).toEqual(['tiers']);
    expect(priceDiffs(meteredPrice(), spec(LOOKUP.essentialUsage), 'prod_usage', 'mtr_2')).toEqual(['recurring.meter']);
  });
});
