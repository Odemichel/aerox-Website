import { describe, it, expect } from 'vitest';
import { LOOKUP, PRICES, PRODUCTS, priceDiffs, type ExistingPrice } from '../src/lib/billing/catalog';

const spec = (lookup: string) => PRICES.find((p) => p.lookup_key === lookup)!;

const unitPrice = (over: Partial<ExistingPrice> = {}): ExistingPrice => ({
  product: 'prod_studio',
  currency: 'eur',
  unit_amount: 6900,
  tax_behavior: 'exclusive',
  billing_scheme: 'per_unit',
  tiers_mode: null,
  tiers: null,
  recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed', meter: null },
  ...over,
});

const usagePrice = (over: Partial<ExistingPrice> = {}): ExistingPrice => ({
  product: 'prod_usage',
  currency: 'eur',
  unit_amount: null,
  tax_behavior: 'exclusive',
  billing_scheme: 'tiered',
  tiers_mode: 'graduated',
  tiers: [
    { up_to: 10, unit_amount: 0, flat_amount: null },
    { up_to: null, unit_amount: 800, flat_amount: null },
  ],
  recurring: { interval: 'month', interval_count: 1, usage_type: 'metered', meter: 'mtr_1' },
  ...over,
});

describe('catalogue bike fitter', () => {
  it('donne un produit connu à chaque prix et des lookup_key uniques', () => {
    const keys = new Set(PRODUCTS.map((p) => p.key));
    for (const p of PRICES) expect(keys.has(p.product)).toBe(true);
    expect(new Set(PRICES.map((p) => p.lookup_key)).size).toBe(PRICES.length);
  });

  it('respecte la grille tarifaire (HT, EUR)', () => {
    expect(spec(LOOKUP.pack10)).toMatchObject({ unit_amount: 15000 });
    expect(spec(LOOKUP.pack10).recurring).toBeUndefined();
    expect(spec(LOOKUP.studioBase)).toMatchObject({ unit_amount: 6900 });
    expect(spec(LOOKUP.unlimited)).toMatchObject({ unit_amount: 12900 });
    expect(spec(LOOKUP.unlimitedLaunch)).toMatchObject({ unit_amount: 6900 });
    expect(spec(LOOKUP.unlimitedLaunchAfter)).toMatchObject({ unit_amount: 9900 });
    expect(spec(LOOKUP.studioUsage).tiers).toEqual([
      { up_to: 10, unit_amount: 0 },
      { up_to: 'inf', unit_amount: 800 },
    ]);
    for (const p of PRICES) expect(p).toMatchObject({ currency: 'eur', tax_behavior: 'exclusive' });
  });
});

describe('priceDiffs', () => {
  it('ne signale rien sur un prix conforme', () => {
    expect(priceDiffs(unitPrice(), spec(LOOKUP.studioBase), 'prod_studio')).toEqual([]);
    expect(priceDiffs(usagePrice(), spec(LOOKUP.studioUsage), 'prod_usage', 'mtr_1')).toEqual([]);
  });

  it('accepte un produit développé (expand)', () => {
    expect(priceDiffs(unitPrice({ product: { id: 'prod_studio' } }), spec(LOOKUP.studioBase), 'prod_studio')).toEqual(
      []
    );
  });

  it('détecte un changement de montant ou de TVA', () => {
    expect(priceDiffs(unitPrice({ unit_amount: 7900 }), spec(LOOKUP.studioBase), 'prod_studio')).toEqual([
      'unit_amount',
    ]);
    expect(priceDiffs(unitPrice({ tax_behavior: 'inclusive' }), spec(LOOKUP.studioBase), 'prod_studio')).toEqual([
      'tax_behavior',
    ]);
  });

  it('détecte un prix récurrent là où un paiement unique est attendu', () => {
    expect(priceDiffs(unitPrice({ unit_amount: 15000 }), spec(LOOKUP.pack10), 'prod_studio')).toEqual(['recurring']);
  });

  it('détecte des paliers modifiés ou un meter différent', () => {
    const tiers = [
      { up_to: 10, unit_amount: 0, flat_amount: null },
      { up_to: null, unit_amount: 900, flat_amount: null },
    ];
    expect(priceDiffs(usagePrice({ tiers }), spec(LOOKUP.studioUsage), 'prod_usage', 'mtr_1')).toEqual(['tiers']);
    expect(priceDiffs(usagePrice(), spec(LOOKUP.studioUsage), 'prod_usage', 'mtr_2')).toEqual(['recurring.meter']);
  });
});
