import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { appProxyCanonical, verifyProxySignature } from "./verify.ts";
import {
  adminHttpError,
  buildThresholdMap,
  discountCombines,
  discountForCountry,
  discountThresholds,
  freeRateMinimum,
  isThrottled,
  parseLookup,
  pickLowestThreshold,
  throttleDelayMs,
  thresholdsByProfile,
  tokenSource,
  type DiscountFreeShipping,
  type MethodDefinition,
} from "./shipping.ts";

// Canonical-string vectors copied verbatim from Shopify's official appProxy tests
// (shopify-app-js, hmac-validator.test.ts). Independent of our own hashing.
const T = "1317327555";
const base = { shop: "the shop URL", logged_in_customer_id: "1", path_prefix: "/apps/my_app", timestamp: T };

test("app proxy canonical string matches Shopify's fixtures", () => {
  assert.equal(
    appProxyCanonical(new URLSearchParams(base)),
    `logged_in_customer_id=1path_prefix=/apps/my_appshop=the shop URLtimestamp=${T}`,
  );

  assert.equal(
    appProxyCanonical(new URLSearchParams({ ...base, foo: "bar" })),
    `foo=barlogged_in_customer_id=1path_prefix=/apps/my_appshop=the shop URLtimestamp=${T}`,
  );

  const repeated = new URLSearchParams(base);
  repeated.append("consentGiven", "true");
  repeated.append("consentGiven", "false");
  assert.equal(
    appProxyCanonical(repeated),
    `consentGiven=true,falselogged_in_customer_id=1path_prefix=/apps/my_appshop=the shop URLtimestamp=${T}`,
  );
});

test("verify accepts a valid signature, rejects tampering", () => {
  const secret = "my super secret key";
  const params = new URLSearchParams({ shop: "shop.myshopify.com", timestamp: T });
  params.set("signature", crypto.createHmac("sha256", secret).update(appProxyCanonical(params)).digest("hex"));
  assert.equal(verifyProxySignature(params, secret), true);
  assert.equal(verifyProxySignature(params, "wrong secret"), false);

  params.set("shop", "evil.myshopify.com");
  assert.equal(verifyProxySignature(params, secret), false);
  assert.equal(verifyProxySignature(new URLSearchParams("shop=x"), secret), false);
});

const eur = (amount: string) => ({ amount, currencyCode: "EUR" });
const priceMin = (amount: string, currencyCode = "EUR") => ({
  field: "TOTAL_PRICE",
  operator: "GREATER_THAN_OR_EQUAL_TO",
  conditionCriteria: { amount, currencyCode },
});

test("freeRateMinimum only accepts free rates gated by a minimum order price", () => {
  const m = (price: string, conds: MethodDefinition["methodConditions"], active = true): MethodDefinition => ({
    active,
    rateProvider: { price: eur(price) },
    methodConditions: conds,
  });
  assert.deepEqual(freeRateMinimum(m("0.0", [priceMin("50.0")])), { threshold: 5000, currency: "EUR" });
  assert.equal(freeRateMinimum(m("0.0", [])), null); // unconditional free rate
  assert.equal(freeRateMinimum(m("13.99", [priceMin("50.0")])), null); // not free
  assert.equal(freeRateMinimum(m("0.0", [priceMin("0.0")])), null); // >= 0 is no threshold
  assert.equal(freeRateMinimum(m("0.0", [priceMin("50.0")], false)), null); // inactive
  assert.equal(
    freeRateMinimum(m("0.0", [{ field: "TOTAL_WEIGHT", operator: "GREATER_THAN_OR_EQUAL_TO", conditionCriteria: null }])),
    null,
  );
  // Zero-decimal currencies come back 2-decimal-normalized: 4,200,000 IDR -> "4200000.0"
  assert.deepEqual(freeRateMinimum(m("0.0", [priceMin("4200000.0", "IDR")])), { threshold: 420000000, currency: "IDR" });
});

test("pickLowestThreshold picks the lowest non-null", () => {
  assert.deepEqual(
    pickLowestThreshold([{ threshold: 8000, currency: "SGD" }, null, { threshold: 6000, currency: "SGD" }]),
    { threshold: 6000, currency: "SGD" },
  );
  assert.equal(pickLowestThreshold([null]), null);
  assert.equal(pickLowestThreshold([]), null);
});

test("buildThresholdMap matches navegaid's real data shape", () => {
  const zone = (codes: string[], methods: MethodDefinition[]) => ({
    zone: { countries: codes.map((countryCode) => ({ code: { countryCode } })) },
    methodDefinitions: { nodes: methods },
  });
  const profiles = [
    {
      profileLocationGroups: [
        {
          locationGroupZones: {
            nodes: [
              zone(["DE"], [
                { active: true, rateProvider: { price: eur("0.0") }, methodConditions: [priceMin("50.0")] },
                { active: true, rateProvider: { price: eur("0.0") }, methodConditions: [] },
              ]),
              zone(["CA", "US"], [
                { active: true, rateProvider: { price: eur("19.99") }, methodConditions: [priceMin("0.0")] },
              ]),
            ],
          },
        },
      ],
    },
  ];
  const markets = [
    { handle: "de", conditions: { regionsCondition: { regions: { nodes: [{ code: "DE" }] } } } },
    { handle: "united-states", conditions: { regionsCondition: { regions: { nodes: [{ code: "US" }] } } } },
    { handle: "no-conditions", conditions: null },
  ];
  const map = buildThresholdMap(markets, profiles);
  assert.deepEqual(map.get("de"), { threshold: 5000, currency: "EUR" });
  assert.equal(map.get("united-states"), null);
  assert.equal(map.get("us"), null);
  assert.equal(map.get("no-conditions"), null);
  assert.equal(map.has("fr"), false);
});

test("tokenSource prefers the static admin token", () => {
  assert.equal(tokenSource({ SHOPIFY_ADMIN_TOKEN: "shpat_x", SHOPIFY_API_KEY: "k", SHOPIFY_API_SECRET: "s" }), "static");
  assert.equal(tokenSource({ SHOPIFY_API_KEY: "k", SHOPIFY_API_SECRET: "s" }), "client_credentials");
  assert.equal(
    tokenSource({ SHOPIFY_ADMIN_TOKEN: "  ", SHOPIFY_API_KEY: "k", SHOPIFY_API_SECRET: "s" }),
    "client_credentials",
  );
  assert.equal(tokenSource({ SHOPIFY_API_KEY: "k" }), null);
  assert.equal(tokenSource({}), null);
});

test("parseLookup: country wins, validated; market kept for backward compatibility", () => {
  const q = (query: string) => parseLookup(new URLSearchParams(query));
  assert.deepEqual(q("country=de"), { kind: "country", code: "DE" });
  assert.deepEqual(q("country=DE&market=united-states"), { kind: "country", code: "DE" });
  assert.deepEqual(q("market=united-states&country=us"), { kind: "country", code: "US" });
  assert.deepEqual(q("country=XX1"), { kind: "error", error: "invalid country param" });
  assert.deepEqual(q("country="), { kind: "error", error: "invalid country param" });
  assert.deepEqual(q("country=1A"), { kind: "error", error: "invalid country param" });
  assert.deepEqual(q("country=XX1&market=de"), { kind: "error", error: "invalid country param" });
  assert.deepEqual(q("market=de"), { kind: "market", key: "de" });
  assert.deepEqual(q("market=%20"), { kind: "error", error: "missing country or market param" });
  assert.deepEqual(q(""), { kind: "error", error: "missing country or market param" });
});

test("isThrottled detects Shopify THROTTLED errors only", () => {
  assert.equal(isThrottled([{ message: "Throttled", extensions: { code: "THROTTLED" } }]), true);
  assert.equal(isThrottled([{ message: "x", extensions: { code: "ACCESS_DENIED" } }, { extensions: { code: "THROTTLED" } }]), true);
  assert.equal(isThrottled([{ message: "x", extensions: { code: "ACCESS_DENIED" } }]), false);
  assert.equal(isThrottled([null]), false);
  assert.equal(isThrottled({ extensions: { code: "THROTTLED" } }), false);
  assert.equal(isThrottled(undefined), false);
});

test("throttleDelayMs waits for the bucket to refill, clamped to 1-10 s", () => {
  assert.equal(throttleDelayMs({ requestedQueryCost: 624, throttleStatus: { currentlyAvailable: 100, restoreRate: 100 } }), 6000);
  assert.equal(throttleDelayMs({ requestedQueryCost: 50, throttleStatus: { currentlyAvailable: 1500, restoreRate: 100 } }), 1000);
  assert.equal(throttleDelayMs({ requestedQueryCost: 990, throttleStatus: { currentlyAvailable: 0, restoreRate: 10 } }), 10000);
  assert.equal(throttleDelayMs(undefined), 1000);
});

test("adminHttpError explains auth failures", () => {
  assert.ok(adminHttpError(401).includes("Reinstall"));
  assert.ok(adminHttpError(403).includes("read_markets"));
  assert.ok(adminHttpError(403).includes("scope"));
  assert.equal(adminHttpError(500), "Admin API HTTP 500");
});

const freeZone = (codes: string[], amount: string) => ({
  zone: { countries: codes.map((countryCode) => ({ code: { countryCode } })) },
  methodDefinitions: {
    nodes: [{ active: true, rateProvider: { price: eur("0.0") }, methodConditions: [priceMin(amount)] }],
  },
});

test("thresholdsByProfile keeps each profile separate, lowest within a profile", () => {
  const byProfile = thresholdsByProfile([
    {
      id: "P1",
      profileLocationGroups: [
        { locationGroupZones: { nodes: [freeZone(["DE"], "50.0"), freeZone(["US"], "100.0")] } },
        { locationGroupZones: { nodes: [freeZone(["DE"], "40.0")] } }, // second location group
      ],
    },
    { id: "P2", profileLocationGroups: [{ locationGroupZones: { nodes: [freeZone(["DE"], "80.0")] } }] },
  ]);
  assert.deepEqual(byProfile.get("P1")?.get("DE"), { threshold: 4000, currency: "EUR" });
  assert.deepEqual(byProfile.get("P1")?.get("US"), { threshold: 10000, currency: "EUR" });
  assert.deepEqual(byProfile.get("P2")?.get("DE"), { threshold: 8000, currency: "EUR" });
  assert.equal(byProfile.get("P2")?.get("US") ?? null, null);
});

test("discountThresholds counts only unrestricted automatic free-shipping discounts", () => {
  const d = (over: Partial<DiscountFreeShipping>): DiscountFreeShipping => ({
    __typename: "DiscountAutomaticFreeShipping",
    status: "ACTIVE",
    combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: false },
    appliesOnOneTimePurchase: true,
    maximumShippingPrice: null,
    minimumRequirement: null,
    destinationSelection: { __typename: "DiscountCountryAll", allCountries: true },
    context: { __typename: "DiscountBuyerSelectionAll" },
    ...over,
  });
  const subtotal = (amount: string) => ({
    __typename: "DiscountMinimumSubtotal",
    greaterThanOrEqualToSubtotal: eur(amount),
  });
  const countries = (...codes: string[]) => ({ __typename: "DiscountCountries", countries: codes });
  const markets = [
    { id: "M1", handle: "de", conditions: { regionsCondition: { regions: { nodes: [{ code: "DE" }] } } } },
    { id: "M2", handle: "eu", conditions: { regionsCondition: { regions: { nodes: [{ code: "FR" }, { code: "IT" }] } } } },
  ];
  const run = (list: DiscountFreeShipping[]) => discountThresholds(list, markets, "EUR");

  // No minimum -> threshold 0 everywhere.
  assert.deepEqual(discountForCountry(run([d({})]), "us"), { threshold: 0, currency: "EUR" });
  // Subtotal minimum.
  assert.deepEqual(discountForCountry(run([d({ minimumRequirement: subtotal("30.0") })]), "DE"), {
    threshold: 3000,
    currency: "EUR",
  });
  // Ignored: quantity minimum, max shipping price, subscription-only, customer context, non-active.
  const ignored = run([
    d({ minimumRequirement: { __typename: "DiscountMinimumQuantity" } }),
    d({ maximumShippingPrice: eur("5.0") }),
    d({ appliesOnOneTimePurchase: false }),
    d({ context: { __typename: "DiscountCustomers" } }),
    d({ context: { __typename: "DiscountCustomerSegments" } }),
    d({ status: "EXPIRED" }),
  ]);
  assert.equal(ignored.all, null);
  assert.equal(ignored.byCountry.size, 0);
  // Destination list limits countries.
  const listed = run([d({ minimumRequirement: subtotal("20.0"), destinationSelection: countries("DE", "AT") })]);
  assert.equal(listed.all, null);
  assert.deepEqual(discountForCountry(listed, "AT"), { threshold: 2000, currency: "EUR" });
  assert.equal(discountForCountry(listed, "US"), null);
  // Market context limits to the market's countries, intersected with the destination.
  const byMarket = run([
    d({ context: { __typename: "DiscountMarkets", marketsCount: 1, markets: { nodes: [{ id: "M2" }] } } }),
    d({
      minimumRequirement: subtotal("10.0"),
      destinationSelection: countries("DE", "IT"),
      context: { __typename: "DiscountMarkets", marketsCount: 1, markets: { nodes: [{ id: "M2" }] } },
    }),
  ]);
  assert.deepEqual(discountForCountry(byMarket, "FR"), { threshold: 0, currency: "EUR" });
  assert.deepEqual(discountForCountry(byMarket, "IT"), { threshold: 0, currency: "EUR" });
  assert.equal(discountForCountry(byMarket, "DE"), null);
  // Market list not fully read -> ignored.
  const partial = run([d({ context: { __typename: "DiscountMarkets", marketsCount: 60, markets: { nodes: [{ id: "M1" }] } } })]);
  assert.equal(discountForCountry(partial, "DE"), null);
  // Lowest per country wins, across "all" and country-specific.
  const lowest = run([
    d({ minimumRequirement: subtotal("70.0") }),
    d({ minimumRequirement: subtotal("40.0"), destinationSelection: countries("DE") }),
    d({ minimumRequirement: subtotal("60.0"), destinationSelection: countries("DE") }),
  ]);
  assert.deepEqual(discountForCountry(lowest, "DE"), { threshold: 4000, currency: "EUR" });
  assert.deepEqual(discountForCountry(lowest, "FR"), { threshold: 7000, currency: "EUR" });
});

test("discountCombines follows both sides' combination settings, conservatively", () => {
  const d = (productDiscounts: boolean, orderDiscounts: boolean) =>
    ({ combinesWith: { productDiscounts, orderDiscounts, shippingDiscounts: false } }) as DiscountFreeShipping;
  const cart = (product = false, order = false, code = false) => ({ product, order, code });

  // No other discount on the cart -> always usable, even if another discount blocks shipping.
  assert.equal(discountCombines(d(false, false), cart(), true), true);
  // Product discount on the cart: this discount must allow product discounts...
  assert.equal(discountCombines(d(true, false), cart(true), false), true);
  assert.equal(discountCombines(d(false, true), cart(true), false), false);
  // ...and no active automatic discount may refuse shipping combinations (e.g. navegaid "sale auto").
  assert.equal(discountCombines(d(true, true), cart(true), true), false);
  // Order discount on the cart.
  assert.equal(discountCombines(d(false, true), cart(false, true), false), true);
  assert.equal(discountCombines(d(true, false), cart(false, true), false), false);
  // A discount code: its combination settings are unknown -> not usable.
  assert.equal(discountCombines(d(true, true), cart(false, false, true), false), false);
});
