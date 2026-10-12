import crypto from "node:crypto";

// Must match `scopes` in shopify.app.toml (enforced by a unit test).
export const SCOPES = "read_discounts,read_markets,read_products,read_shipping,write_app_proxy";
export const STATE_COOKIE = "shopify_oauth_state";

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

// "https://NavegaID.myshopify.com/" -> "navegaid.myshopify.com"; anything that isn't a
// bare *.myshopify.com host -> null.
export function normalizeShop(input: string | null | undefined): string | null {
  const shop = (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  return SHOP_RE.test(shop) ? shop : null;
}

// Message Shopify signs for admin/OAuth redirects: all params except hmac/signature,
// sorted by key, URL-encoded and joined with "&" (same as @shopify/shopify-api).
export function adminHmacMessage(params: URLSearchParams): string {
  const entries = [...params].filter(([key]) => key !== "hmac" && key !== "signature");
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new URLSearchParams(entries).toString();
}

export function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function verifyAdminHmac(params: URLSearchParams, secret: string): boolean {
  const provided = params.get("hmac");
  if (!provided || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(adminHmacMessage(params), "utf8").digest("hex");
  return safeEqual(provided.toLowerCase(), expected);
}

export function newState(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function callbackUrl(appUrl: string | undefined, origin: string): string {
  return `${(appUrl?.trim() || origin).replace(/\/+$/, "")}/api/auth/callback`;
}

// Offline access token (no grant_options[]=per-user).
export function authorizeUrl(shop: string, clientId: string, redirectUri: string, state: string): string {
  const query = new URLSearchParams({ client_id: clientId, scope: SCOPES, redirect_uri: redirectUri, state });
  return `https://${shop}/admin/oauth/authorize?${query}`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
