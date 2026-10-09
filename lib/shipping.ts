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

async function adminGraphql<T>(query: string): Promise<T> {
  const store = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN");
  const res = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query }),
  });
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
