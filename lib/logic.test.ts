import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { appProxyCanonical, proxySignature, verifyProxySignature } from "./verify.ts";
import { buildThresholdMap, freeRateMinimum, pickLowestThreshold, type MethodDefinition } from "./shipping.ts";

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
