import type { Threshold } from "./shipping.ts";

// Pure cart evaluation: which free-shipping threshold applies to this cart and how much is left.
// All amounts are subunits (cents) in the cart's presentment currency.

// Discounts already applied to the cart (from /cart.js): automatic product/order discounts, any code.
export type CartDiscounts = { product: boolean; order: boolean; code: boolean };
export type CartBody = { currency: string; rate: number; total: number; variantIds: number[]; discounts: CartDiscounts };

export type CartResult =
  | { free: boolean; threshold: number; remaining: number; currency: string }
  | { free: false; threshold: null; remaining: null; currency: null };

export const HIDE: CartResult = { free: false, threshold: null, remaining: null, currency: null };
export const MAX_VARIANTS = 250;

export function parseCartBody(raw: unknown): { ok: true; value: CartBody } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "body must be an object" };
  const { currency, rate, total, variant_ids, product_discount, order_discount, discount_code } = raw as Record<
    string,
    unknown
  >;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "invalid currency" };
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return { ok: false, error: "invalid rate" };
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) return { ok: false, error: "invalid total" };
  if (!Array.isArray(variant_ids) || variant_ids.length < 1 || variant_ids.length > MAX_VARIANTS) {
    return { ok: false, error: `variant_ids must have 1..${MAX_VARIANTS} entries` };
  }
  if (!variant_ids.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0)) {
    return { ok: false, error: "invalid variant id" };
  }
  if (![product_discount, order_discount, discount_code].every((b) => typeof b === "boolean")) {
    return { ok: false, error: "product_discount, order_discount and discount_code must be booleans" };
  }
  return {
    ok: true,
    value: {
      currency,
      rate,
      total,
      variantIds: [...new Set(variant_ids as number[])],
      discounts: { product: product_discount as boolean, order: order_discount as boolean, code: discount_code as boolean },
    },
  };
}

// Threshold in cart currency, or null if it can't be converted safely.
// `rate` is Shopify.currency.rate (cart currency per shop currency unit).
export function convertThreshold(t: Threshold, cartCurrency: string, shopCurrency: string, rate: number): number | null {
  if (t.currency === cartCurrency) return t.threshold;
  if (t.currency === shopCurrency) return Math.round(t.threshold * rate);
  return null;
}

export type EvaluateInput = {
  country: string;
  total: number;
  currency: string;
  rate: number;
  shopCurrency: string;
  // Delivery profile id per shippable variant in the cart (null = unknown variant).
  profiles: (string | null)[];
  byProfile: Map<string, Map<string, Threshold | null>>;
  discount: Threshold | null;
};

export function evaluateCart(input: EvaluateInput): CartResult {
  const { country, total, currency, rate, shopCurrency } = input;
  const convert = (t: Threshold | null) => (t ? convertThreshold(t, currency, shopCurrency, rate) : null);

  // Every item must ship to the country: its profile needs a zone for it (a country key in
  // byProfile). Otherwise checkout can't ship there, so no path applies, discounts included.
  const zones = [...new Set(input.profiles)].map((p) => (p ? input.byProfile.get(p) : undefined));
  if (zones.length === 0 || zones.some((z) => !z?.has(country))) return HIDE;

  // Rates path: Shopify checks price conditions against the cart total and charges each
  // profile's rate, so the cart ships free once the highest profile threshold is reached.
  let rates: number | null = null;
  for (const z of zones) {
    const t = convert(z!.get(country) ?? null);
    if (t === null) {
      rates = null;
      break;
    }
    rates = Math.max(rates ?? 0, t);
  }
  const discount = convert(input.discount);

  const candidates = [rates, discount].filter((t): t is number => t !== null);
  if (candidates.length === 0) return HIDE;
  // Smallest remaining wins; with the same total that is the smallest threshold (tie -> rates, first).
  const threshold = candidates.reduce((a, b) => (b < a ? b : a));
  const remaining = Math.max(0, threshold - total);
  return { free: remaining === 0, threshold, remaining, currency };
}
