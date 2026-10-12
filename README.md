# Market Shipping Threshold App

Single-store Shopify custom app. It reads the free-shipping thresholds already configured in the store's shipping profiles and serves the right one per market/country to the storefront free-shipping bar, through a Shopify app proxy. Amounts come from the shipping profiles, not from currency conversion of a theme setting.

## Response contract

### `POST /apps/shipping-threshold?country=<ISO 3166-1 alpha-2>` (theme contract)

Storefront request via app proxy → `/api/proxy`. `country` is the customer's active storefront country (`localization.country.iso_code`).

Body (built from `/cart.js`):

```json
{ "currency": "EUR", "rate": 1.0, "total": 1000, "variant_ids": [123, 456] }
```

- `currency`: cart currency (`/^[A-Z]{3}$/`). `rate`: `Shopify.currency.rate` (finite, > 0). `total`: `cart.total_price` (integer subunits, >= 0). `variant_ids`: shippable cart lines, 1..250 positive integers.

Response (cart-currency subunits, `Cache-Control: no-store`):

```json
{ "free": false, "threshold": 5000, "remaining": 4000, "currency": "EUR" }
```

- `{ "free": false, "threshold": null, "remaining": null, "currency": null }` = no threshold for this market/cart → hide the bar.
- Errors (all → hide the bar): `401` bad signature, `403` other shop, `400` invalid `country` / JSON / body field, `413` body > 16 KB, `500` Admin API failure.

### `GET /apps/shipping-threshold?country=XX` (legacy / debug)

Returns `{ "threshold", "currency" }` (lowest across all profiles) or nulls. `?market=<handle>` is still accepted; `country` wins. Cached `public, max-age=300`. The theme no longer uses it.

## How thresholds are derived

- Rate threshold: an active shipping rate priced `0` with only "Minimum order price" conditions (`TOTAL_PRICE >= X`, X > 0). Kept per delivery profile and country (lowest within a profile).
- Mixed-profile cart: Shopify checks price conditions against the cart total and adds up each profile's rate ([combined shipping rates](https://help.shopify.com/en/manual/fulfillment/setup/shipping-profiles/combined-shipping-rates)), so the cart is free once it reaches the **highest** threshold of the profiles in it. If any profile in the cart (or an unknown variant) has no threshold for the country, the rate path is unavailable.
- Automatic discount threshold: an active automatic free-shipping discount counts when it applies to one-time purchases, has no maximum shipping price, has no minimum (threshold 0) or a minimum subtotal, its destination covers the country, and it applies to all buyers or to markets containing the country. Lowest per country wins. Compared against the cart total.
- The path (rates or discount) with the smaller remaining amount is shown.
- Currency: a threshold in the cart currency is used as is; a threshold in the shop currency is converted with `rate`; any other currency makes that path unavailable.
- Ignored on purpose: unconditional and weight-based free rates; discounts with a quantity minimum, a maximum shipping price, subscription-only, customer/segment eligibility, app (Functions) discounts, and discount codes.
- Admin data (markets, profiles, zones, rates, discounts, shop currency) is fully paginated and cached for 5 minutes per warm instance; variant → profile lookups are cached 5 minutes. If data can't be read completely, the request fails (500) instead of using a partial threshold.

## Environment variables

| Variable               | Where             | Purpose                                                                  |
| ---------------------- | ----------------- | ------------------------------------------------------------------------ |
| `SHOPIFY_API_KEY`      | everywhere        | App client ID (OAuth, client credentials on the test store)              |
| `SHOPIFY_API_SECRET`   | everywhere        | App proxy signature + OAuth HMAC verification, token exchange            |
| `SHOPIFY_STORE_DOMAIN` | everywhere        | The one allowed shop, e.g. `client-store.myshopify.com`                  |
| `SHOPIFY_ADMIN_TOKEN`  | client store only | Offline Admin API token from the install page. Takes priority when set   |
| `SHOPIFY_API_VERSION`  | optional          | Admin API version, default `2026-10`                                     |
| `SHOPIFY_APP_URL`      | recommended       | Base URL for the OAuth `redirect_uri` (falls back to the request origin) |

Scopes: `read_discounts,read_markets,read_products,read_shipping,write_app_proxy` (kept in sync with `shopify.app.toml` by a unit test). After a scope change run `shopify app deploy` and approve the update on the store (client store: reinstall and replace `SHOPIFY_ADMIN_TOKEN`).

## Test store setup (same Dev Dashboard org)

1. `shopify app deploy` to push `shopify.app.toml` (scopes, app proxy, redirect URLs).
2. Install the app on the test store.
3. In Vercel set `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_STORE_DOMAIN`, and leave `SHOPIFY_ADMIN_TOKEN` unset. The app then mints tokens with the client credentials grant, which only works for stores in the app's own org.

A stale `SHOPIFY_ADMIN_TOKEN` left in Vercel takes priority over client credentials and will cause 401s. Remove it on the test deployment.

## Client store install (different org, custom distribution)

1. `shopify app deploy` (so the client grants the current scopes).
2. Dev Dashboard → the app → Distribution → Custom distribution → enter the client's `*.myshopify.com` domain and generate the install link.
3. The client opens the link and installs. Shopify opens the app URL (`/`), which verifies the HMAC and redirects through `/api/auth` to the OAuth consent screen and back to `/api/auth/callback`.
4. The callback page shows the offline Admin API token once. Copy it.
5. In Vercel (Production) set `SHOPIFY_ADMIN_TOKEN=<token>` and `SHOPIFY_STORE_DOMAIN=<client>.myshopify.com`, then redeploy.

The token doesn't expire. Reinstall (`/api/auth?shop=<client>.myshopify.com`) if the app is uninstalled, the token leaks, or scopes change. Nothing is stored server-side.

## Troubleshooting

- `Admin API 401` in the logs: token rejected. Reinstall and update `SHOPIFY_ADMIN_TOKEN`.
- `Admin API 403`: usually a missing scope. Run `shopify app deploy` and reinstall.
- Data is fully paginated; every query stays under Shopify's 1000-point cost limit (page sizes in `lib/pagination.ts`).
- `Threshold fetch exceeded 50 Admin API requests`: the store is larger than the safety cap. Raise `MAX_REQUESTS` or the page sizes in `lib/pagination.ts` (keep each query under 1000 cost).
- `Admin API throttled after 3 retries`: Shopify rate limit. Throttled requests are retried automatically; this only appears under sustained load.

## Development

```bash
npm test          # unit tests (node --test)
npx tsc --noEmit
npx eslint lib app
npm run build
```

## Theme integration

- `layout/theme.liquid` adds `country` and `currency` to `window.theme.settings` and loads `assets/shipping-threshold.js`.
- `window.ShippingThreshold.evaluate(cart)` takes the `/cart.js` JSON, POSTs the body above (4 s timeout, memoizes the last identical cart) and returns the result or `null`.
- `updateFreeShipping()` in `assets/global.js` uses that result: `null` or empty cart → bar hidden; `free` → success text, 100 %; otherwise the remaining amount in the existing text and progress `(threshold - remaining) / threshold`. Design and markup are unchanged.
- `snippets/shipping-bar.liquid` renders the bar hidden until JS fills it.
- Keep **Enable shipping notification** on and the theme's threshold setting > 0: it still gates rendering the bar, but its value is no longer used.

## Manual QA checklist (storefront, after a Vercel deploy)

1. DE cart below €50 → remaining amount correct; at/above €50 → success text, full bar.
2. US / CA / ID (no threshold) → bar hidden.
3. Switch country with the country selector → bar updates for the new country.
4. Switch to a non-EUR currency for DE → threshold converted from EUR.
5. Second shipping profile: Settings → Shipping and delivery → create a custom profile with one product, give DE a free rate with a higher minimum (e.g. €80). Cart with products from both profiles → threshold €80. Remove the free DE rate from that profile → bar hidden for mixed carts.
6. Discounts → create an automatic free-shipping discount (no minimum / minimum subtotal €30 / limited to some countries). Wait ≤ 5 min (cache) → lower threshold shown where it applies. Disable it afterwards.
7. Empty cart → hidden. Gift card only → hidden.
