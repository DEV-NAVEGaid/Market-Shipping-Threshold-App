import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { appProxyCanonical, proxySignature, verifyProxySignature } from "./verify.ts";
import { buildThresholdMap, pickLowestThreshold } from "./shipping.ts";

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

test("pickLowestThreshold picks lowest non-null and converts to subunits", () => {
  assert.deepEqual(
    pickLowestThreshold([
      { freeDeliveryMinimumValue: { amount: "60.00", currencyCode: "SGD" } },
      { freeDeliveryMinimumValue: null },
      { freeDeliveryMinimumValue: { amount: "80.00", currencyCode: "SGD" } },
    ]),
    { threshold: 6000, currency: "SGD" },
  );
  // Shopify stores IDR (zero-decimal) 2-decimal-normalized: 4,200,000 -> "4200000.00"
  assert.deepEqual(
    pickLowestThreshold([{ freeDeliveryMinimumValue: { amount: "4200000.00", currencyCode: "IDR" } }]),
    { threshold: 420000000, currency: "IDR" },
  );
  assert.equal(pickLowestThreshold([{ freeDeliveryMinimumValue: null }]), null);
  assert.equal(pickLowestThreshold([]), null);
});

test("buildThresholdMap resolves by handle and by country code", () => {
  const map = buildThresholdMap([
    {
      handle: "germany",
      conditions: { regionsCondition: { regions: { nodes: [{ code: "DE" }] } } },
      delivery: {
        shipping: {
          optionDefinitions: {
            nodes: [
              { freeDeliveryMinimumValue: { amount: "50.00", currencyCode: "EUR" } },
              { freeDeliveryMinimumValue: null },
            ],
          },
        },
      },
    },
    { handle: "no-conditions", conditions: null, delivery: null },
  ]);
  const de = { threshold: 5000, currency: "EUR" };
  assert.deepEqual(map.get("germany"), de);
  assert.deepEqual(map.get("de"), de);
  assert.equal(map.get("no-conditions"), null);
  assert.equal(map.has("fr"), false);
});
