import test from "node:test";
import assert from "node:assert/strict";
import { fetchThresholdData, type GraphqlFetcher } from "./pagination.ts";
import {
  buildThresholdMap,
  thresholdsByCountry,
  type DiscountFreeShipping,
  type MethodDefinition,
  type ThresholdData,
} from "./shipping.ts";

// In-memory store shaped like navegaid, but with enough items to need several pages at first:1.
const paid = (amount: string): MethodDefinition => ({
  active: true,
  rateProvider: { price: { amount, currencyCode: "EUR" } },
  methodConditions: [],
});
const freeAbove = (amount: string): MethodDefinition => ({
  active: true,
  rateProvider: { price: { amount: "0.0", currencyCode: "EUR" } },
  methodConditions: [
    { field: "TOTAL_PRICE", operator: "GREATER_THAN_OR_EQUAL_TO", conditionCriteria: { amount, currencyCode: "EUR" } },
  ],
});

type StoreZone = { id: string; countries: string[]; rates: MethodDefinition[] };
type StoreGroup = { id: string; zones: StoreZone[] };
const STORE = {
  markets: [
    { id: "gid://shopify/Market/1", handle: "de", regions: ["DE"] },
    { id: "gid://shopify/Market/2", handle: "eu", regions: ["FR", "IT", "AT"] },
    { id: "gid://shopify/Market/3", handle: "legacy", regions: null as string[] | null },
  ],
  profiles: [
    {
      id: "gid://shopify/DeliveryProfile/1",
      groups: [
        {
          id: "gid://shopify/DeliveryLocationGroup/1",
          zones: [
            // The free rate is on the LAST rate page.
            { id: "gid://shopify/DeliveryZone/1", countries: ["DE"], rates: [paid("4.99"), paid("9.99"), freeAbove("50.0")] },
            { id: "gid://shopify/DeliveryZone/2", countries: ["FR", "IT"], rates: [freeAbove("60.0")] },
            // Same country, lower threshold, on a later zone page.
            { id: "gid://shopify/DeliveryZone/3", countries: ["DE"], rates: [freeAbove("40.0")] },
          ],
        },
      ] as StoreGroup[],
    },
    {
      id: "gid://shopify/DeliveryProfile/2",
      groups: [
        { id: "gid://shopify/DeliveryLocationGroup/2", zones: [{ id: "gid://shopify/DeliveryZone/4", countries: ["AT"], rates: [paid("9.99")] }] },
      ] as StoreGroup[],
    },
  ],
};

const freeShipping = (status: string): DiscountFreeShipping => ({
  __typename: "DiscountAutomaticFreeShipping",
  status,
  appliesOnOneTimePurchase: true,
  maximumShippingPrice: null,
  minimumRequirement: null,
  destinationSelection: { __typename: "DiscountCountryAll", allCountries: true },
  context: { __typename: "DiscountBuyerSelectionAll" },
});
// Search filters should already exclude the last two; the fetch layer drops them anyway.
const DISCOUNTS: DiscountFreeShipping[] = [
  freeShipping("ACTIVE"),
  freeShipping("SCHEDULED"),
  { __typename: "DiscountAutomaticBasic" } as DiscountFreeShipping,
];

const EXPECTED: ThresholdData = {
  shopCurrency: "EUR",
  discounts: { nodes: [DISCOUNTS[0]] },
  markets: {
    nodes: [
      { id: "gid://shopify/Market/1", handle: "de", conditions: { regionsCondition: { regions: { nodes: [{ code: "DE" }] } } } },
      {
        id: "gid://shopify/Market/2",
        handle: "eu",
        conditions: { regionsCondition: { regions: { nodes: [{ code: "FR" }, { code: "IT" }, { code: "AT" }] } } },
      },
      { id: "gid://shopify/Market/3", handle: "legacy", conditions: null },
    ],
  },
  deliveryProfiles: {
    nodes: STORE.profiles.map((p) => ({
      id: p.id,
      profileLocationGroups: p.groups.map((g) => ({
        locationGroupZones: {
          nodes: g.zones.map((z) => ({
            zone: { countries: z.countries.map((countryCode) => ({ code: { countryCode } })) },
            methodDefinitions: { nodes: z.rates },
          })),
        },
      })),
    })),
  },
};

// Cursors are the item index; endCursor is the last returned index.
function page<T>(items: T[], first: number, after: unknown) {
  const start = after == null ? 0 : Number(after) + 1;
  const slice = items.slice(start, start + first).map((item, i) => ({ item, cursor: String(start + i) }));
  return {
    pageInfo: { hasNextPage: start + first < items.length, endCursor: slice.at(-1)?.cursor ?? null },
    slice,
  };
}
const nodesPage = <T>(items: T[], first: number, after: unknown) => {
  const { pageInfo, slice } = page(items, first, after);
  return { pageInfo, nodes: slice.map((s) => s.item) };
};
const regionsOf = (codes: string[], first: number, after: unknown) =>
  nodesPage(codes.map((code) => ({ code })), first, after);
const rawZone = (z: StoreZone, ratesFirst: number) => ({
  zone: { id: z.id, countries: z.countries.map((countryCode) => ({ code: { countryCode } })) },
  methodDefinitions: nodesPage(z.rates, ratesFirst, null),
});
const zoneEdges = (zones: StoreZone[], first: number, after: unknown, ratesFirst: number) => {
  const { pageInfo, slice } = page(zones, first, after);
  return { pageInfo, edges: slice.map((s) => ({ cursor: s.cursor, node: rawZone(s.item, ratesFirst) })) };
};
const groupOf = (profileId: unknown, groupId: unknown) => {
  const profile = STORE.profiles.find((p) => p.id === profileId);
  return { profile, groups: profile ? profile.groups.filter((g) => g.id === groupId) : [] };
};

type Tamper = (operation: string, data: unknown) => unknown;

function fakeFetcher(tamper?: Tamper) {
  const calls: string[] = [];
  const gql: GraphqlFetcher = async <T>(query: string, v: Record<string, unknown>) => {
    const operation = /query (\w+)/.exec(query)![1];
    calls.push(operation);
    let data: unknown;
    switch (operation) {
      case "ThresholdMarkets":
        data = {
          markets: (() => {
            const { pageInfo, nodes } = nodesPage(STORE.markets, v.first as number, v.after);
            return {
              pageInfo,
              nodes: nodes.map((m) => ({
                id: m.id,
                handle: m.handle,
                conditions: m.regions
                  ? { regionsCondition: { regions: regionsOf(m.regions, v.regionsFirst as number, null) } }
                  : null,
              })),
            };
          })(),
        };
        break;
      case "ThresholdMarketRegions": {
        const m = STORE.markets.find((x) => x.id === v.id);
        data = {
          market: m?.regions
            ? { conditions: { regionsCondition: { regions: regionsOf(m.regions, v.first as number, v.after) } } }
            : null,
        };
        break;
      }
      case "ThresholdProfiles": {
        const { pageInfo, nodes } = nodesPage(STORE.profiles, v.first as number, v.after);
        data = {
          deliveryProfiles: {
            pageInfo,
            nodes: nodes.map((p) => ({
              id: p.id,
              profileLocationGroups: p.groups.map((g) => ({
                locationGroup: { id: g.id },
                locationGroupZones: zoneEdges(g.zones, v.zonesFirst as number, null, v.ratesFirst as number),
              })),
            })),
          },
        };
        break;
      }
      case "ThresholdZones": {
        const { profile, groups } = groupOf(v.profileId, v.locationGroupId);
        data = {
          deliveryProfile: profile
            ? {
              profileLocationGroups: groups.map((g) => ({
                locationGroupZones: zoneEdges(g.zones, v.first as number, v.after, v.ratesFirst as number),
              })),
            }
            : null,
        };
        break;
      }
      case "ThresholdRates": {
        const { profile, groups } = groupOf(v.profileId, v.locationGroupId);
        data = {
          deliveryProfile: profile
            ? {
              profileLocationGroups: groups.map((g) => ({
                locationGroupZones: {
                  nodes: page(g.zones, 1, v.zoneAfter).slice.map(({ item }) => ({
                    zone: { id: item.id },
                    methodDefinitions: nodesPage(item.rates, v.first as number, v.after),
                  })),
                },
              })),
            }
            : null,
        };
        break;
      }
      case "ThresholdDiscounts": {
        const { pageInfo, nodes } = nodesPage(DISCOUNTS, v.first as number, v.after);
        data = { shop: { currencyCode: "EUR" }, discountNodes: { pageInfo, nodes: nodes.map((discount) => ({ discount })) } };
        break;
      }
      default:
        throw new Error(`unexpected operation ${operation}`);
    }
    return { data: (tamper ? tamper(operation, data) : data) as T, requestedQueryCost: 1 };
  };
  return { gql, calls };
}

const TINY = { markets: 1, regions: 1, profiles: 1, zones: 1, rates: 1, discounts: 1 };

test("default page sizes: one markets + one profiles + one discounts request, complete data", async () => {
  const { gql, calls } = fakeFetcher();
  const { data, costs } = await fetchThresholdData(gql);
  assert.deepEqual(calls, ["ThresholdMarkets", "ThresholdProfiles", "ThresholdDiscounts"]);
  assert.deepEqual(costs, [1, 1, 1]);
  assert.deepEqual(data, EXPECTED);
});

test("first:1 everywhere walks every connection and assembles the same data", async () => {
  const { gql, calls } = fakeFetcher();
  const { data, costs } = await fetchThresholdData(gql, { pageSizes: TINY, maxRequests: 500 });
  for (const op of [
    "ThresholdMarkets",
    "ThresholdMarketRegions",
    "ThresholdProfiles",
    "ThresholdZones",
    "ThresholdRates",
    "ThresholdDiscounts",
  ]) {
    assert.ok(calls.includes(op), `${op} was used`);
  }
  // 3 market pages + 2 extra "eu" region pages; 2 profile pages + 2 zone pages + 2 rate pages; 3 discount pages.
  assert.equal(calls.length, 14);
  assert.equal(costs.length, calls.length);
  assert.deepEqual(data, EXPECTED);

  const full = await fetchThresholdData(fakeFetcher().gql);
  const sorted = (m: Map<string, unknown>) => [...m].sort();
  assert.deepEqual(
    sorted(buildThresholdMap(data.markets.nodes, data.deliveryProfiles.nodes)),
    sorted(buildThresholdMap(full.data.markets.nodes, full.data.deliveryProfiles.nodes)),
  );
  const byCountry = thresholdsByCountry(data.deliveryProfiles.nodes);
  assert.deepEqual(byCountry.get("DE"), { threshold: 4000, currency: "EUR" }); // lower zone on a later page
  assert.deepEqual(byCountry.get("FR"), { threshold: 6000, currency: "EUR" });
  assert.equal(byCountry.get("AT"), null);
  assert.deepEqual(buildThresholdMap(data.markets.nodes, data.deliveryProfiles.nodes).get("eu"), {
    threshold: 6000,
    currency: "EUR",
  });
});

test("free rate on the last rate page is found", async () => {
  const { data } = await fetchThresholdData(fakeFetcher().gql, { pageSizes: TINY, maxRequests: 500 });
  const zone1 = data.deliveryProfiles.nodes[0].profileLocationGroups[0].locationGroupZones.nodes[0];
  assert.equal(zone1.methodDefinitions.nodes.length, 3);
  assert.deepEqual(zone1.methodDefinitions.nodes[2], freeAbove("50.0"));
});

test("request cap exceeded throws instead of returning partial data", async () => {
  await assert.rejects(
    fetchThresholdData(fakeFetcher().gql, { pageSizes: TINY, maxRequests: 3 }),
    /exceeded 3 Admin API requests/,
  );
});

test("a different zone on a rate follow-up page throws", async () => {
  const tamper: Tamper = (operation, data) => {
    if (operation !== "ThresholdRates") return data;
    const d = data as { deliveryProfile: { profileLocationGroups: { locationGroupZones: { nodes: { zone: { id: string } }[] } }[] } };
    d.deliveryProfile.profileLocationGroups[0].locationGroupZones.nodes[0].zone.id = "gid://shopify/DeliveryZone/999";
    return d;
  };
  await assert.rejects(
    fetchThresholdData(fakeFetcher(tamper).gql, { pageSizes: TINY, maxRequests: 500 }),
    /zone order changed/,
  );
});

test("hasNextPage without endCursor throws", async () => {
  const tamper: Tamper = (operation, data) => {
    if (operation !== "ThresholdMarkets") return data;
    const d = data as { markets: { pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
    d.markets.pageInfo = { hasNextPage: true, endCursor: null };
    return d;
  };
  await assert.rejects(fetchThresholdData(fakeFetcher(tamper).gql), /hasNextPage without endCursor/);
});

test("invalid page size throws", async () => {
  await assert.rejects(fetchThresholdData(fakeFetcher().gql, { pageSizes: { zones: 0 } }), /Invalid page size for zones/);
  await assert.rejects(fetchThresholdData(fakeFetcher().gql, { pageSizes: { rates: 251 } }), /Invalid page size for rates/);
});

test("time budget exceeded throws instead of returning partial data", async () => {
  await assert.rejects(
    fetchThresholdData(fakeFetcher().gql, { pageSizes: TINY, maxRequests: 500, deadlineMs: -1 }),
    /time budget/,
  );
});
