const API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2026-10";

export type Threshold = { threshold: number; currency: string };

type MoneyV2 = { amount: string; currencyCode: string };
type OptionDef = { freeDeliveryMinimumValue: MoneyV2 | null };

const MARKETS_QUERY = `
  query Markets {
    markets(first: 50) {
      nodes {
        handle
        delivery {
          shipping {
            optionDefinitions(first: 50, active: true) {
              nodes {
                freeDeliveryMinimumValue { amount currencyCode }
              }
            }
          }
        }
      }
    }
  }
`;

type MarketsData = {
  markets: {
    nodes: {
      handle: string;
      delivery: {
        shipping: { optionDefinitions: { nodes: OptionDef[] } } | null;
      } | null;
    }[];
  };
};

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

export function pickLowestThreshold(options: OptionDef[]): Threshold | null {
  let best: Threshold | null = null;
  for (const option of options) {
    const value = option.freeDeliveryMinimumValue;
    if (!value) continue;
    const threshold = Math.round(Number(value.amount) * 100);
    if (best === null || threshold < best.threshold) {
      best = { threshold, currency: value.currencyCode };
    }
  }
  return best;
}

// ponytail: module cache, best-effort on serverless (per warm instance). Add Redis only if Admin API rate limits bite.
let cache: { at: number; map: Map<string, Threshold | null> } = { at: 0, map: new Map() };
const TTL_MS = 5 * 60 * 1000;

export async function getThresholdForMarket(handle: string): Promise<Threshold | null> {
  if (Date.now() - cache.at < TTL_MS) return cache.map.get(handle) ?? null;
  const data = await adminGraphql<MarketsData>(MARKETS_QUERY);
  const map = new Map<string, Threshold | null>();
  for (const market of data.markets.nodes) {
    const options = market.delivery?.shipping?.optionDefinitions?.nodes ?? [];
    map.set(market.handle, pickLowestThreshold(options));
  }
  cache = { at: Date.now(), map };
  return map.get(handle) ?? null;
}
