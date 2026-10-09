const API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2026-10";

export type Threshold = { threshold: number; currency: string };

type MoneyV2 = { amount: string; currencyCode: string };

// Markets give us handle -> countries. The free-shipping threshold itself lives on the
// delivery profiles: a rate priced 0 with a "TOTAL_PRICE >= X" condition.
// (Market.delivery.shipping is null on this store, so it can't be used as the source.)
const THRESHOLD_QUERY = `
  query Thresholds {
    markets(first: 50) {
      nodes {
        handle
        conditions {
          regionsCondition {
            regions(first: 50) {
              nodes { ... on MarketRegionCountry { code } }
            }
          }
        }
      }
    }
    deliveryProfiles(first: 10) {
      nodes {
        profileLocationGroups {
          locationGroupZones(first: 20) {
            nodes {
              zone { countries { code { countryCode } } }
              methodDefinitions(first: 20) {
                nodes {
                  active
                  rateProvider { ... on DeliveryRateDefinition { price { amount currencyCode } } }
                  methodConditions {
                    field
                    operator
                    conditionCriteria { ... on MoneyV2 { amount currencyCode } }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export type MarketNode = {
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
  profileLocationGroups: { locationGroupZones: { nodes: ZoneNode[] } }[];
};

type ThresholdData = {
  markets: { nodes: MarketNode[] };
  deliveryProfiles: { nodes: DeliveryProfileNode[] };
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

function storeDomain(): string {
  // Accept "navegaid.myshopify.com" as well as "https://navegaid.myshopify.com/".
  const store = process.env.SHOPIFY_STORE_DOMAIN?.trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!store) throw new Error("Missing SHOPIFY_STORE_DOMAIN");
  return store;
}

// Client credentials grant tokens expire after ~24h; cache per warm instance and refresh early.
let tokenCache: { token: string; expiresAt: number } | null = null;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

async function getAccessToken(store: string): Promise<string> {
  const clientId = process.env.SHOPIFY_API_KEY;
  const clientSecret = process.env.SHOPIFY_API_SECRET;

  if (!clientId || !clientSecret) {
    // Fallback: static token (must be rotated manually if it expires).
    const staticToken = process.env.SHOPIFY_ADMIN_TOKEN;
    if (!staticToken) throw new Error("Missing SHOPIFY_API_KEY/SHOPIFY_API_SECRET or SHOPIFY_ADMIN_TOKEN");
    return staticToken;
  }

  if (tokenCache && Date.now() < tokenCache.expiresAt - REFRESH_MARGIN_MS) return tokenCache.token;

  const res = await fetch(`https://${store}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
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

async function adminGraphql<T>(query: string): Promise<T> {
  const store = storeDomain();
  const token = await getAccessToken(store);
  const res = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query }),
  });
  if (res.status === 401) tokenCache = null; // force a fresh token on the next request
  if (!res.ok) throw new Error(`Admin API HTTP ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data as T;
}

// ponytail: module cache, best-effort on serverless (per warm instance). Add Redis only if Admin API rate limits bite.
let cache: { at: number; map: Map<string, Threshold | null> } = { at: 0, map: new Map() };
const TTL_MS = 5 * 60 * 1000;

// `market` may be a market handle ("germany") or an ISO country code ("de").
export async function getThresholdForMarket(market: string): Promise<Threshold | null> {
  const key = market.trim().toLowerCase();
  if (Date.now() - cache.at < TTL_MS) return cache.map.get(key) ?? null;
  const data = await adminGraphql<ThresholdData>(THRESHOLD_QUERY);
  cache = { at: Date.now(), map: buildThresholdMap(data.markets.nodes, data.deliveryProfiles.nodes) };
  return cache.map.get(key) ?? null;
}
