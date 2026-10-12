import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  SCOPES,
  adminHmacMessage,
  authorizeUrl,
  callbackUrl,
  escapeHtml,
  normalizeShop,
  safeEqual,
  verifyAdminHmac,
} from "./oauth.ts";

// Vector from Shopify's OAuth docs (secret "hush").
const DOC_MESSAGE =
  "code=0907a61c0c8d55e99db179b68161bc00&shop=some-shop.myshopify.com&state=0.6784241404160823&timestamp=1337178173";
const DOC_HMAC = "700e2dadb827fcc8609e9d5ce208b2e9cdaab9df07390d2cbca10d7c328fc4bf";

test("admin HMAC matches Shopify's documented vector", () => {
  const params = new URLSearchParams(`${DOC_MESSAGE}&hmac=${DOC_HMAC}`);
  assert.equal(adminHmacMessage(params), DOC_MESSAGE);
  assert.equal(verifyAdminHmac(params, "hush"), true);
  assert.equal(verifyAdminHmac(params, "wrong"), false);

  const withSignature = new URLSearchParams(params);
  withSignature.set("signature", "x");
  assert.equal(adminHmacMessage(withSignature), DOC_MESSAGE);

  const tampered = new URLSearchParams(params);
  tampered.set("shop", "evil.myshopify.com");
  assert.equal(verifyAdminHmac(tampered, "hush"), false);

  const noHmac = new URLSearchParams(params);
  noHmac.delete("hmac");
  assert.equal(verifyAdminHmac(noHmac, "hush"), false);

  const shortHmac = new URLSearchParams(params);
  shortHmac.set("hmac", "abc");
  assert.equal(verifyAdminHmac(shortHmac, "hush"), false);
});

test("admin HMAC message sorts keys and URL-encodes values", () => {
  const params = new URLSearchParams({ timestamp: "1", shop: "a.myshopify.com", host: "YWRtaW4=" });
  assert.equal(adminHmacMessage(params), "host=YWRtaW4%3D&shop=a.myshopify.com&timestamp=1");
});

test("normalizeShop accepts only *.myshopify.com", () => {
  assert.equal(normalizeShop("navegaid.myshopify.com"), "navegaid.myshopify.com");
  assert.equal(normalizeShop("https://NavegaID.myshopify.com/"), "navegaid.myshopify.com");
  for (const bad of [
    "evil.com",
    "navegaid.myshopify.com.evil.com",
    "-x.myshopify.com",
    "a/b.myshopify.com",
    "navegaid.myshopify.com/admin",
    "",
    null,
    undefined,
  ]) {
    assert.equal(normalizeShop(bad), null, String(bad));
  }
});

test("safeEqual", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), false);
});

test("authorizeUrl requests offline token with app scopes", () => {
  const redirect = "https://x.vercel.app/api/auth/callback";
  const url = new URL(authorizeUrl("navegaid.myshopify.com", "client123", redirect, "state456"));
  assert.equal(url.host, "navegaid.myshopify.com");
  assert.equal(url.pathname, "/admin/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "client123");
  assert.equal(url.searchParams.get("scope"), SCOPES);
  assert.equal(url.searchParams.get("redirect_uri"), redirect);
  assert.equal(url.searchParams.get("state"), "state456");
  assert.equal(url.searchParams.has("grant_options[]"), false);
});

test("callbackUrl", () => {
  assert.equal(callbackUrl("https://x.vercel.app/", "http://localhost:3000"), "https://x.vercel.app/api/auth/callback");
  assert.equal(callbackUrl(undefined, "http://localhost:3000"), "http://localhost:3000/api/auth/callback");
  assert.equal(callbackUrl("  ", "http://localhost:3000"), "http://localhost:3000/api/auth/callback");
});

test("escapeHtml", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("SCOPES matches shopify.app.toml", () => {
  const toml = fs.readFileSync(path.join(import.meta.dirname, "..", "shopify.app.toml"), "utf8");
  const match = toml.match(/^scopes = "(.*)"\s*$/m);
  assert.ok(match, "scopes line not found");
  assert.equal(match[1], SCOPES);
});
