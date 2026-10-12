import test from "node:test";
import assert from "node:assert/strict";
import { HIDE, convertThreshold, evaluateCart, parseCartBody, type EvaluateInput } from "./cart.ts";
import type { Threshold } from "./shipping.ts";

const eur = (threshold: number): Threshold => ({ threshold, currency: "EUR" });
const byProfile = new Map<string, Map<string, Threshold | null>>([
  ["P1", new Map([["DE", eur(5000)], ["US", null]])],
  ["P2", new Map([["DE", eur(8000)]])],
  ["P3", new Map([["DE", null]])],
]);
const run = (over: Partial<EvaluateInput>) =>
  evaluateCart({
    country: "DE",
    total: 1000,
    currency: "EUR",
    rate: 1,
    shopCurrency: "EUR",
    profiles: ["P1"],
    byProfile,
    discount: null,
    ...over,
  });

test("single profile: remaining below threshold, free at threshold", () => {
  assert.deepEqual(run({}), { free: false, threshold: 5000, remaining: 4000, currency: "EUR" });
  assert.deepEqual(run({ total: 5000 }), { free: true, threshold: 5000, remaining: 0, currency: "EUR" });
  assert.deepEqual(run({ total: 6000 }), { free: true, threshold: 5000, remaining: 0, currency: "EUR" });
});

test("mixed-profile cart uses the highest profile threshold", () => {
  assert.deepEqual(run({ profiles: ["P1", "P2", "P1"], total: 6000 }), {
    free: false,
    threshold: 8000,
    remaining: 2000,
    currency: "EUR",
  });
});

test("a profile without a threshold, an unknown variant, or a country without one hides the bar", () => {
  assert.deepEqual(run({ profiles: ["P1", "P3"] }), HIDE);
  assert.deepEqual(run({ profiles: ["P1", null] }), HIDE);
  assert.deepEqual(run({ profiles: ["P1", "UNKNOWN"] }), HIDE);
  assert.deepEqual(run({ country: "US" }), HIDE);
  assert.deepEqual(run({ profiles: [] }), HIDE);
});

test("discount path", () => {
  // Lower discount minimum beats the rates threshold.
  assert.deepEqual(run({ discount: eur(3000) }), { free: false, threshold: 3000, remaining: 2000, currency: "EUR" });
  // No-minimum discount -> free.
  assert.deepEqual(run({ discount: eur(0) }), { free: true, threshold: 0, remaining: 0, currency: "EUR" });
  // Rates unavailable -> discount alone.
  assert.deepEqual(run({ profiles: ["P3"], discount: eur(7000) }), {
    free: false,
    threshold: 7000,
    remaining: 6000,
    currency: "EUR",
  });
  // Higher discount minimum loses to the rates threshold.
  assert.deepEqual(run({ discount: eur(9000) }).threshold, 5000);
  // Tie -> same threshold either way.
  assert.deepEqual(run({ discount: eur(5000) }), { free: false, threshold: 5000, remaining: 4000, currency: "EUR" });
});

test("currency conversion: same, shop currency, other", () => {
  assert.equal(convertThreshold(eur(5000), "EUR", "EUR", 1.1), 5000);
  assert.equal(convertThreshold(eur(5000), "USD", "EUR", 1.1), 5500);
  assert.equal(convertThreshold({ threshold: 5000, currency: "GBP" }, "USD", "EUR", 1.1), null);
  assert.equal(convertThreshold({ threshold: 6000, currency: "USD" }, "USD", "EUR", 1.1), 6000);
  // Cart in USD: EUR threshold converted with the storefront rate.
  assert.deepEqual(run({ currency: "USD", rate: 1.1 }), { free: false, threshold: 5500, remaining: 4500, currency: "USD" });
  // Unconvertible threshold -> that path is unavailable.
  const gbp = new Map([["P1", new Map([["DE", { threshold: 5000, currency: "GBP" }]])]]);
  assert.deepEqual(run({ currency: "USD", rate: 1.1, byProfile: gbp }), HIDE);
  assert.deepEqual(run({ currency: "USD", rate: 1.1, byProfile: gbp, discount: eur(2000) }).threshold, 2200);
});

test("parseCartBody validates strictly", () => {
  const ok = { currency: "EUR", rate: 1, total: 1000, variant_ids: [1, 2, 2] };
  assert.deepEqual(parseCartBody(ok), { ok: true, value: { currency: "EUR", rate: 1, total: 1000, variantIds: [1, 2] } });
  const bad: unknown[] = [
    null,
    "x",
    [],
    { ...ok, currency: "eur" },
    { ...ok, currency: "EURO" },
    { ...ok, rate: 0 },
    { ...ok, rate: Number.NaN },
    { ...ok, rate: "1" },
    { ...ok, total: -1 },
    { ...ok, total: 10.5 },
    { ...ok, variant_ids: [] },
    { ...ok, variant_ids: Array.from({ length: 251 }, (_, i) => i + 1) },
    { ...ok, variant_ids: [1.5] },
    { ...ok, variant_ids: [0] },
    { ...ok, variant_ids: ["1"] },
    { currency: "EUR", rate: 1, total: 1000 },
    {},
  ];
  for (const body of bad) assert.equal(parseCartBody(body).ok, false, JSON.stringify(body));
});
