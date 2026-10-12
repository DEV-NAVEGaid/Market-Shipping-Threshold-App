import { normalizeShop, SCOPES } from "./oauth.ts";
import { fetchThresholdData, type FetchOptions, type GraphqlFetcher } from "./pagination.ts";
import { evaluateCart, type CartBody, type CartResult } from "./cart.ts";

const API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2026-10";

export type Threshold = { threshold: number; currency: string };

type MoneyV2 = { amount: string; currencyCode: string };
// Markets give us handle -> countries. The free-shipping threshold itself lives on the
// delivery profiles: a rate priced 0 with a "TOTAL_PRICE >= X" condition.
// (Market.delivery.shipping is null on this store, so it can't be used as the source.)
// The Admin API queries and their cursor pagination live in ./pagination.ts.

export type MarketNode = {
  id?: string;
  handle: string;
  conditions?: {
    regionsCondition: { regions: { nodes: { code?: string }[] } } | null;
  } | null;
};

export type MethodDefinition = {
  active: boolean;
  rateProvider: { price?: MoneyV2 } | null;
  methodConditions: {
    field: string;
    operator: string;
    conditionCriteria: Partial<MoneyV2> | null;
  }[];
};

export type ZoneNode = {
  zone: { countries: { code: { countryCode: string | null } }[] };
  methodDefinitions: { nodes: MethodDefinition[] };
};

export type DeliveryProfileNode = {
  id?: string;
  profileLocationGroups: { locationGroupZones: { nodes: ZoneNode[] } }[];
};

// Active automatic free-shipping discount, raw Admin API union shapes (2026-10).
export type DiscountFreeShipping = {
  __typename: string; // "DiscountAutomaticFreeShipping"; other discount types are dropped while fetching
  status: string;
  appliesOnOneTimePurchase: boolean;
  maximumShippingPrice: MoneyV2 | null;
  minimumRequirement: { __typename: string; greaterThanOrEqualToSubtotal?: MoneyV2 } | null;
  destinationSelection: { __typename: string; countries?: string[]; allCountries?: boolean };
  context: { __typename: string; marketsCount?: number; markets?: { nodes: { id: string }[] } };
};

// Complete (fully paginated) data: nodes only, no pageInfo.
export type ThresholdData = {
  markets: { nodes: MarketNode[] };
  deliveryProfiles: { nodes: DeliveryProfileNode[] };
  shopCurrency: string;
  discounts: { nodes: DiscountFreeShipping[] };
};

// Minimum order value (in subunits) that unlocks a free rate, or null if the rate
// isn't a "free above X" rate. Only pure price conditions count; weight-based or
// unconditional free rates are ignored.
export function freeRateMinimum(method: MethodDefinition): Threshold | null {
  const price = method.rateProvider?.price;
  if (!method.active || !price || Number(price.amount) !== 0) return null;
  if (method.methodConditions.length === 0) return null;

  let min: Threshold | null = null;
  for (const c of method.methodConditions) {
    if (c.field !== "TOTAL_PRICE") return null;
    if (c.operator !== "GREATER_THAN_OR_EQUAL_TO") continue;
    const amount = Number(c.conditionCriteria?.amount);
    if (!(amount > 0) || !c.conditionCriteria?.currencyCode) continue;
    // Shopify returns 2-decimal-normalized amounts even for zero-decimal currencies.
    min = { threshold: Math.round(amount * 100), currency: c.conditionCriteria.currencyCode };
  }
  return min;
}

export function pickLowestThreshold(candidates: (Threshold | null)[]): Threshold | null {
  let best: Threshold | null = null;
  for (const t of candidates) {
    if (t && (best === null || t.threshold < best.threshold)) best = t;
  }
  return best;
}

// Lowest "free above X" threshold per country (uppercase ISO code), across all profiles.
export function thresholdsByCountry(profiles: DeliveryProfileNode[]): Map<string, Threshold | null> {
  const result = new Map<string, Threshold | null>();
  for (const profile of profiles) {
    for (const group of profile.profileLocationGroups) {
      for (const zone of group.locationGroupZones.nodes) {
        const zoneMin = pickLowestThreshold(zone.methodDefinitions.nodes.map(freeRateMinimum));
        for (const country of zone.zone.countries) {
          const code = country.code.countryCode;
          if (!code) continue;
          result.set(code, pickLowestThreshold([result.get(code) ?? null, zoneMin]));
        }
      }
    }
  }
  return result;
}

// Lowest "free above X" threshold per country, kept separately for each delivery profile.
// A cart ships free via rates only if every profile in it has a free rate for the country.
export function thresholdsByProfile(profiles: DeliveryProfileNode[]): Map<string, Map<string, Threshold | null>> {
  const result = new Map<string, Map<string, Threshold | null>>();
  for (const profile of profiles) {
    if (!profile.id) continue;
    result.set(profile.id, thresholdsByCountry([profile]));
  }
  return result;
}

export type DiscountThresholds = { all: Threshold | null; byCountry: Map<string, Threshold> };

// Minimum subtotal per country that unlocks an active automatic free-shipping discount.
// Counted only when it applies to everyone on one-time purchases with no shipping-price cap,
// and the minimum is none (threshold 0) or a subtotal. Anything else is ignored.
export function discountThresholds(
  discounts: DiscountFreeShipping[],
  markets: MarketNode[],
  shopCurrency: string,
): DiscountThresholds {
  const marketCountries = new Map<string, string[]>();
  for (const m of markets) {
    if (!m.id) continue;
    const codes = (m.conditions?.regionsCondition?.regions.nodes ?? []).map((r) => r.code).filter(Boolean);
    marketCountries.set(m.id, codes as string[]);
  }

  let all: Threshold | null = null;
  const byCountry = new Map<string, Threshold>();
  const add = (code: string, t: Threshold) => byCountry.set(code, pickLowestThreshold([byCountry.get(code) ?? null, t])!);

  for (const d of discounts) {
    if (d.status !== "ACTIVE" || !d.appliesOnOneTimePurchase || d.maximumShippingPrice) continue;

    let t: Threshold;
    const min = d.minimumRequirement;
    if (!min) t = { threshold: 0, currency: shopCurrency };
    else if (min.__typename === "DiscountMinimumSubtotal" && min.greaterThanOrEqualToSubtotal) {
      const amount = Number(min.greaterThanOrEqualToSubtotal.amount);
      if (!(amount >= 0)) continue;
      t = { threshold: Math.round(amount * 100), currency: min.greaterThanOrEqualToSubtotal.currencyCode };
    } else continue; // quantity minimum or unknown

    // Countries allowed by the buyer context (null = every country).
    let contextCountries: string[] | null;
    if (d.context.__typename === "DiscountBuyerSelectionAll") contextCountries = null;
    else if (d.context.__typename === "DiscountMarkets" && d.context.markets) {
      if ((d.context.marketsCount ?? Infinity) > d.context.markets.nodes.length) continue; // not all markets read
      contextCountries = d.context.markets.nodes.flatMap((m) => marketCountries.get(m.id) ?? []);
    } else continue; // customer / segment / unknown context

    const dest = d.destinationSelection;
    let destCountries: string[] | null;
    if (dest.__typename === "DiscountCountryAll" && dest.allCountries) destCountries = null;
    else if (dest.__typename === "DiscountCountries" && dest.countries) destCountries = dest.countries;
    else continue;

    if (contextCountries === null && destCountries === null) {
      all = pickLowestThreshold([all, t]);
      continue;
    }
    const codes =
      contextCountries === null
        ? destCountries!
        : destCountries === null
          ? contextCountries
          : contextCountries.filter((c) => destCountries!.includes(c));
    for (const code of codes) add(code.toUpperCase(), t);
  }
  return { all, byCountry };
}

export function discountForCountry(d: DiscountThresholds, country: string): Threshold | null {
  return pickLowestThreshold([d.all, d.byCountry.get(country.toUpperCase()) ?? null]);
}

// Lookup keys are lowercase: market handle ("de", "united-states") or country code ("us").
// Market handles win over country codes when they collide.
export function buildThresholdMap(
  markets: MarketNode[],
  profiles: DeliveryProfileNode[],
): Map<string, Threshold | null> {
  const perCountry = thresholdsByCountry(profiles);
  const byHandle = new Map<string, Threshold | null>();
  const byCountry = new Map<string, Threshold | null>();
  for (const [code, t] of perCountry) byCountry.set(code.toLowerCase(), t);
  for (const market of markets) {
    const codes = (market.conditions?.regionsCondition?.regions.nodes ?? [])
      .map((r) => r.code)
      .filter((c): c is string => Boolean(c));
    byHandle.set(market.handle.toLowerCase(), pickLowestThreshold(codes.map((c) => perCountry.get(c) ?? null)));
  }
  return new Map([...byCountry, ...byHandle]);
}

export type Lookup =
  | { kind: "country"; code: string }
  | { kind: "market"; key: string }
  | { kind: "error"; error: string };

// `country` (ISO 3166-1 alpha-2) wins whenever present, even if invalid; `market` is kept
// for backward compatibility.
export function parseLookup(params: URLSearchParams): Lookup {
  const country = params.get("country");
  if (country !== null) {
    return /^[A-Za-z]{2}$/.test(country)
      ? { kind: "country", code: country.toUpperCase() }
      : { kind: "error", error: "invalid country param" };
  }
  const market = params.get("market")?.trim();
  return market ? { kind: "market", key: market } : { kind: "error", error: "missing country or market param" };
}

// The one store this app serves. Accepts "navegaid.myshopify.com" or "https://navegaid.myshopify.com/".
export function storeDomain(): string {
  const store = normalizeShop(process.env.SHOPIFY_STORE_DOMAIN);
  if (!store) throw new Error("Missing or invalid SHOPIFY_STORE_DOMAIN");
  return store;
}

type TokenEnv = Partial<Record<"SHOPIFY_ADMIN_TOKEN" | "SHOPIFY_API_KEY" | "SHOPIFY_API_SECRET", string>>;

// "static": non-expiring offline token from the /api/auth install (client store, other org).
// "client_credentials": token minted from key+secret; only works on stores in the app's own org (test store).
export function tokenSource(env: TokenEnv): "static" | "client_credentials" | null {
  if (env.SHOPIFY_ADMIN_TOKEN?.trim()) return "static";
  if (env.SHOPIFY_API_KEY?.trim() && env.SHOPIFY_API_SECRET?.trim()) return "client_credentials";
  return null;
}

export function adminHttpError(status: number): string {
  if (status === 401) {
    return "Admin API 401: access token rejected. Reinstall the app via /api/auth?shop=<store> and update SHOPIFY_ADMIN_TOKEN, or check the token.";
  }
  if (status === 403) {
    return `Admin API 403: access denied, likely a missing scope. Required scopes: ${SCOPES}. Reinstall the app to grant them.`;
  }
  return `Admin API HTTP ${status}`;
}

// Client credentials grant tokens expire after ~24h; cache per warm instance and refresh early.
let tokenCache: { token: string; expiresAt: number } | null = null;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

async function getAccessToken(store: string): Promise<string> {
  const { SHOPIFY_ADMIN_TOKEN, SHOPIFY_API_KEY, SHOPIFY_API_SECRET } = process.env;
  switch (tokenSource({ SHOPIFY_ADMIN_TOKEN, SHOPIFY_API_KEY, SHOPIFY_API_SECRET })) {
    case "static":
      return SHOPIFY_ADMIN_TOKEN!.trim();
    case null:
      throw new Error("Missing SHOPIFY_ADMIN_TOKEN (client store) or SHOPIFY_API_KEY/SHOPIFY_API_SECRET (test store)");
  }

  if (tokenCache && Date.now() < tokenCache.expiresAt - REFRESH_MARGIN_MS) return tokenCache.token;

  const res = await fetch(`https://${store}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SHOPIFY_API_KEY!.trim(),
      client_secret: SHOPIFY_API_SECRET!.trim(),
    }),
  });
  if (!res.ok) throw new Error(`Token request HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Token response missing access_token");

  tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 86399) * 1000,
  };
  return tokenCache.token;
}

type QueryCost = {
  requestedQueryCost?: number;
  throttleStatus?: { currentlyAvailable?: number; restoreRate?: number };
};

const MAX_THROTTLE_RETRIES = 3;
const clampDelay = (ms: number) => Math.min(10_000, Math.max(1_000, ms));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Shopify signals a rate-limited GraphQL query with HTTP 200 + errors[].extensions.code "THROTTLED".
export function isThrottled(errors: unknown): boolean {
  return (
    Array.isArray(errors) &&
    errors.some((e) => (e as { extensions?: { code?: unknown } } | null)?.extensions?.code === "THROTTLED")
  );
}

// Time until the bucket has restored enough points for the query, clamped to 1-10 s.
export function throttleDelayMs(cost?: QueryCost): number {
  const requested = cost?.requestedQueryCost ?? 0;
  const available = cost?.throttleStatus?.currentlyAvailable ?? 0;
  const restoreRate = cost?.throttleStatus?.restoreRate || 50;
  return clampDelay(Math.ceil((requested - available) / restoreRate) * 1000);
}

const adminGraphql: GraphqlFetcher = async <T>(query: string, variables: Record<string, unknown>) => {
  const store = storeDomain();
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken(store);
    const res = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) {
      if (attempt >= MAX_THROTTLE_RETRIES) break;
      await sleep(clampDelay(Number(res.headers.get("Retry-After")) * 1000 || 2000));
      continue;
    }
    if (res.status === 401) tokenCache = null; // force a fresh token on the next request
    if (!res.ok) throw new Error(adminHttpError(res.status));
    const json = (await res.json()) as { data?: T; errors?: unknown; extensions?: { cost?: QueryCost } };
    if (json.errors && isThrottled(json.errors)) {
      if (attempt >= MAX_THROTTLE_RETRIES) break;
      await sleep(throttleDelayMs(json.extensions?.cost));
      continue;
    }
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return { data: json.data as T, requestedQueryCost: json.extensions?.cost?.requestedQueryCost ?? null };
  }
  throw new Error(`Admin API throttled after ${MAX_THROTTLE_RETRIES} retries`);
};

// Complete, fully paginated data plus each request's requestedQueryCost. Throws rather than
// returning partial data (request cap, throttling, inconsistent pages).
export function loadThresholdData(options?: FetchOptions): Promise<{ data: ThresholdData; costs: (number | null)[] }> {
  return fetchThresholdData(adminGraphql, options);
}

type ThresholdMaps = {
  byKey: Map<string, Threshold | null>;
  byCountry: Map<string, Threshold | null>;
  byProfile: Map<string, Map<string, Threshold | null>>;
  discounts: DiscountThresholds;
  shopCurrency: string;
};

// ponytail: module cache, best-effort on serverless (per warm instance). Add Redis only if Admin API rate limits bite.
let cache: { at: number; maps: ThresholdMaps | null } = { at: 0, maps: null };
const TTL_MS = 5 * 60 * 1000;

// Single-flight: concurrent cold requests share one paginated walk instead of each
// draining the Admin API throttle bucket.
let inflight: Promise<ThresholdMaps> | null = null;

async function thresholdMaps(): Promise<ThresholdMaps> {
  if (cache.maps && Date.now() - cache.at < TTL_MS) return cache.maps;
  inflight ??= (async () => {
    try {
      const { data } = await loadThresholdData();
      const maps = {
        byKey: buildThresholdMap(data.markets.nodes, data.deliveryProfiles.nodes),
        byCountry: thresholdsByCountry(data.deliveryProfiles.nodes),
        byProfile: thresholdsByProfile(data.deliveryProfiles.nodes),
        discounts: discountThresholds(data.discounts.nodes, data.markets.nodes, data.shopCurrency),
        shopCurrency: data.shopCurrency,
      };
      cache = { at: Date.now(), maps };
      return maps;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// `market` may be a market handle ("de", "united-states") or an ISO country code ("us").
export async function getThresholdForMarket(market: string): Promise<Threshold | null> {
  return (await thresholdMaps()).byKey.get(market.trim().toLowerCase()) ?? null;
}

// Looks up only by ISO country code, so it can never hit a market handle.
export async function getThresholdForCountry(country: string): Promise<Threshold | null> {
  return (await thresholdMaps()).byCountry.get(country.trim().toUpperCase()) ?? null;
}

// Variant -> delivery profile id, cached per warm instance (same TTL as thresholds).
const variantCache = new Map<number, { profile: string | null; at: number }>();
const VARIANT_CHUNK = 100;

const VARIANT_PROFILES_QUERY = `
  query VariantProfiles($ids: [ID!]!) {
    nodes(ids: $ids) { ... on ProductVariant { id deliveryProfile { id } } }
  }
`;

// Profile id per variant id (same order); null when the variant or its profile is unknown.
export async function resolveVariantProfiles(ids: number[]): Promise<(string | null)[]> {
  const now = Date.now();
  const missing = [...new Set(ids)].filter((id) => {
    const hit = variantCache.get(id);
    return !hit || now - hit.at >= TTL_MS;
  });
  for (let i = 0; i < missing.length; i += VARIANT_CHUNK) {
    const chunk = missing.slice(i, i + VARIANT_CHUNK);
    const { data } = await adminGraphql<{ nodes: ({ id?: string; deliveryProfile?: { id: string } | null } | null)[] }>(
      VARIANT_PROFILES_QUERY,
      { ids: chunk.map((id) => `gid://shopify/ProductVariant/${id}`) },
    );
    const found = new Map<string, string | null>();
    for (const node of data.nodes) if (node?.id) found.set(node.id, node.deliveryProfile?.id ?? null);
    for (const id of chunk) {
      variantCache.set(id, { profile: found.get(`gid://shopify/ProductVariant/${id}`) ?? null, at: now });
    }
  }
  return ids.map((id) => variantCache.get(id)?.profile ?? null);
}

// Free-shipping state of a cart for the customer's active country (ISO code).
export async function evaluateCartForCountry(country: string, body: CartBody): Promise<CartResult> {
  const code = country.trim().toUpperCase();
  const [maps, profiles] = await Promise.all([thresholdMaps(), resolveVariantProfiles(body.variantIds)]);
  return evaluateCart({
    country: code,
    total: body.total,
    currency: body.currency,
    rate: body.rate,
    shopCurrency: maps.shopCurrency,
    profiles,
    byProfile: maps.byProfile,
    discount: discountForCountry(maps.discounts, code),
  });
}
