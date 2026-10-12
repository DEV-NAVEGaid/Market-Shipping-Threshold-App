import type {
  DeliveryProfileNode,
  DiscountFreeShipping,
  MarketNode,
  MethodDefinition,
  ThresholdData,
  ZoneNode,
} from "./shipping.ts";

// Fetch layer: walks every connection with cursor pagination and assembles the complete
// ThresholdData (nodes only), so the pure threshold logic never sees partial data.
// Fails closed: anything that would leave data unread throws instead.

export type PageSizes = {
  markets: number;
  regions: number;
  profiles: number;
  zones: number;
  rates: number;
  discounts: number;
};

// Defaults keep every query well under Shopify's 1000-point single-query cost limit
// (live: initial profiles query 542, markets 86, discounts 101).
export const DEFAULT_PAGE_SIZES: PageSizes = {
  markets: 50,
  regions: 50,
  profiles: 10,
  zones: 20,
  rates: 20,
  discounts: 50,
};

// Hard cap on logical page requests per refresh (throttle retries don't count).
export const MAX_REQUESTS = 50;

export type GraphqlResult<T> = { data: T; requestedQueryCost: number | null };
export type GraphqlFetcher = <T>(query: string, variables: Record<string, unknown>) => Promise<GraphqlResult<T>>;
export type FetchOptions = { pageSizes?: Partial<PageSizes>; maxRequests?: number; deadlineMs?: number };

// Overall budget for one refresh; fail fast instead of being killed by the function timeout.
export const DEADLINE_MS = 20_000;

type PageInfo = { hasNextPage: boolean; endCursor: string | null };
type Connection<N> = { pageInfo: PageInfo; nodes: N[] };
type EdgeConnection<N> = { pageInfo: PageInfo; edges: { cursor: string; node: N }[] };

type RegionNode = { code?: string };
type RawMarket = {
  id: string;
  handle: string;
  conditions?: { regionsCondition: { regions: Connection<RegionNode> } | null } | null;
};
type RawZone = {
  zone: { id: string; countries: ZoneNode["zone"]["countries"] };
  methodDefinitions: Connection<MethodDefinition>;
};
type RawGroup = { locationGroup: { id: string }; locationGroupZones: EdgeConnection<RawZone> };
type RawProfile = { id: string; profileLocationGroups: RawGroup[] };

const RATE_FIELDS = `
  active
  rateProvider { ... on DeliveryRateDefinition { price { amount currencyCode } } }
  methodConditions {
    field
    operator
    conditionCriteria { ... on MoneyV2 { amount currencyCode } }
  }
`;

const ZONE_FIELDS = `
  zone { id countries { code { countryCode } } }
  methodDefinitions(first: $ratesFirst) {
    pageInfo { hasNextPage endCursor }
    nodes { ${RATE_FIELDS} }
  }
`;

const MARKETS_QUERY = `
  query ThresholdMarkets($first: Int!, $after: String, $regionsFirst: Int!) {
    markets(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        conditions {
          regionsCondition {
            regions(first: $regionsFirst) {
              pageInfo { hasNextPage endCursor }
              nodes { ... on MarketRegionCountry { code } }
            }
          }
        }
      }
    }
  }
`;

const MARKET_REGIONS_QUERY = `
  query ThresholdMarketRegions($id: ID!, $first: Int!, $after: String) {
    market(id: $id) {
      conditions {
        regionsCondition {
          regions(first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { ... on MarketRegionCountry { code } }
          }
        }
      }
    }
  }
`;

const PROFILES_QUERY = `
  query ThresholdProfiles($first: Int!, $after: String, $zonesFirst: Int!, $ratesFirst: Int!) {
    deliveryProfiles(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        profileLocationGroups {
          locationGroup { id }
          locationGroupZones(first: $zonesFirst) {
            pageInfo { hasNextPage endCursor }
            edges { cursor node { ${ZONE_FIELDS} } }
          }
        }
      }
    }
  }
`;

const ZONES_QUERY = `
  query ThresholdZones($profileId: ID!, $locationGroupId: ID!, $first: Int!, $after: String, $ratesFirst: Int!) {
    deliveryProfile(id: $profileId) {
      profileLocationGroups(locationGroupId: $locationGroupId) {
        locationGroupZones(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { cursor node { ${ZONE_FIELDS} } }
        }
      }
    }
  }
`;

// DeliveryLocationGroupZone is not a Node, so a zone's next rate page is fetched by
// re-selecting exactly that zone: first 1 zone after the previous zone's edge cursor.
const RATES_QUERY = `
  query ThresholdRates($profileId: ID!, $locationGroupId: ID!, $zoneAfter: String, $first: Int!, $after: String) {
    deliveryProfile(id: $profileId) {
      profileLocationGroups(locationGroupId: $locationGroupId) {
        locationGroupZones(first: 1, after: $zoneAfter) {
          nodes {
            zone { id }
            methodDefinitions(first: $first, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { ${RATE_FIELDS} }
            }
          }
        }
      }
    }
  }
`;

// Shop currency + every active automatic discount (Shopify allows at most 25): free-shipping ones
// are evaluated, the others only tell us whether they refuse to combine with shipping discounts.
const COMBINES_WITH = "combinesWith { productDiscounts orderDiscounts shippingDiscounts }";
const DISCOUNTS_QUERY = `
  query ThresholdDiscounts($first: Int!, $after: String) {
    shop { currencyCode }
    discountNodes(first: $first, after: $after, query: "method:automatic AND status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        discount {
          __typename
          ... on DiscountAutomaticBasic { ${COMBINES_WITH} }
          ... on DiscountAutomaticBxgy { ${COMBINES_WITH} }
          ... on DiscountAutomaticApp { ${COMBINES_WITH} }
          ... on DiscountAutomaticFreeShipping {
            status
            ${COMBINES_WITH}
            appliesOnOneTimePurchase
            maximumShippingPrice { amount currencyCode }
            minimumRequirement {
              __typename
              ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } }
            }
            destinationSelection {
              __typename
              ... on DiscountCountries { countries }
              ... on DiscountCountryAll { allCountries }
            }
            context {
              __typename
              ... on DiscountMarkets { marketsCount markets(first: 50) { nodes { id } } }
            }
          }
        }
      }
    }
  }
`;

function resolvePageSizes(overrides: Partial<PageSizes> = {}): PageSizes {
  const sizes = { ...DEFAULT_PAGE_SIZES, ...overrides };
  for (const [name, value] of Object.entries(sizes)) {
    if (!Number.isInteger(value) || value < 1 || value > 250) {
      throw new Error(`Invalid page size for ${name}: ${value} (must be an integer 1..250)`);
    }
  }
  return sizes;
}

// Cursor for the next page, or null when done. A next page without a cursor can't be fetched.
function nextCursor(pageInfo: PageInfo, label: string): string | null {
  if (!pageInfo.hasNextPage) return null;
  if (!pageInfo.endCursor) throw new Error(`${label}: hasNextPage without endCursor; refusing partial thresholds`);
  return pageInfo.endCursor;
}

export async function fetchThresholdData(
  gql: GraphqlFetcher,
  options: FetchOptions = {},
): Promise<{ data: ThresholdData; costs: (number | null)[] }> {
  const sizes = resolvePageSizes(options.pageSizes);
  const maxRequests = options.maxRequests ?? MAX_REQUESTS;
  const costs: (number | null)[] = [];
  const deadline = Date.now() + (options.deadlineMs ?? DEADLINE_MS);

  async function request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (costs.length >= maxRequests) {
      throw new Error(
        `Threshold fetch exceeded ${maxRequests} Admin API requests; refusing to return partial thresholds`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error("Threshold fetch exceeded its time budget; refusing to return partial thresholds");
    }
    const result = await gql<T>(query, variables);
    costs.push(result.requestedQueryCost);
    return result.data;
  }

  // --- Markets and their regions ---
  const markets: MarketNode[] = [];
  let marketsAfter: string | null = null;
  do {
    const page: { markets: Connection<RawMarket> } = await request(MARKETS_QUERY, {
      first: sizes.markets,
      after: marketsAfter,
      regionsFirst: sizes.regions,
    });
    for (const market of page.markets.nodes) {
      const regions = market.conditions?.regionsCondition?.regions;
      if (!regions) {
        markets.push({ id: market.id, handle: market.handle, conditions: market.conditions });
        continue;
      }
      const nodes = [...regions.nodes];
      let after = nextCursor(regions.pageInfo, `market ${market.handle} regions`);
      while (after) {
        const next: { market: RawMarket | null } = await request(MARKET_REGIONS_QUERY, {
          id: market.id,
          first: sizes.regions,
          after,
        });
        const more = next.market?.conditions?.regionsCondition?.regions;
        if (!more) throw new Error(`market ${market.handle} vanished during region pagination`);
        nodes.push(...more.nodes);
        after = nextCursor(more.pageInfo, `market ${market.handle} regions`);
      }
      markets.push({ id: market.id, handle: market.handle, conditions: { regionsCondition: { regions: { nodes } } } });
    }
    marketsAfter = nextCursor(page.markets.pageInfo, "markets");
  } while (marketsAfter);

  // --- Delivery profiles -> location groups -> zones -> rates ---
  async function collectRates(
    profileId: string,
    locationGroupId: string,
    zoneAfter: string | null,
    zone: RawZone,
  ): Promise<MethodDefinition[]> {
    const nodes = [...zone.methodDefinitions.nodes];
    let after = nextCursor(zone.methodDefinitions.pageInfo, `zone ${zone.zone.id} rates`);
    while (after) {
      const next: { deliveryProfile: { profileLocationGroups: { locationGroupZones: Connection<RawZone> }[] } | null } =
        await request(RATES_QUERY, { profileId, locationGroupId, zoneAfter, first: sizes.rates, after });
      const same = next.deliveryProfile?.profileLocationGroups[0]?.locationGroupZones.nodes[0];
      if (!same || same.zone.id !== zone.zone.id) {
        throw new Error(`zone order changed during pagination (expected ${zone.zone.id})`);
      }
      nodes.push(...same.methodDefinitions.nodes);
      after = nextCursor(same.methodDefinitions.pageInfo, `zone ${zone.zone.id} rates`);
    }
    return nodes;
  }

  async function collectZones(
    profileId: string,
    locationGroupId: string,
    first: EdgeConnection<RawZone>,
  ): Promise<ZoneNode[]> {
    const zones: ZoneNode[] = [];
    let connection = first;
    let prev: string | null = null; // cursor the current page was requested after
    for (; ;) {
      for (const edge of connection.edges) {
        const rates = await collectRates(profileId, locationGroupId, prev, edge.node);
        zones.push({ zone: { countries: edge.node.zone.countries }, methodDefinitions: { nodes: rates } });
        prev = edge.cursor;
      }
      const after = nextCursor(connection.pageInfo, `location group ${locationGroupId} zones`);
      if (!after) return zones;
      const next: { deliveryProfile: { profileLocationGroups: { locationGroupZones: EdgeConnection<RawZone> }[] } | null } =
        await request(ZONES_QUERY, { profileId, locationGroupId, first: sizes.zones, after, ratesFirst: sizes.rates });
      const group = next.deliveryProfile?.profileLocationGroups[0];
      if (!group) throw new Error(`location group ${locationGroupId} vanished during zone pagination`);
      connection = group.locationGroupZones;
      prev = after;
    }
  }

  const profiles: DeliveryProfileNode[] = [];
  let profilesAfter: string | null = null;
  do {
    const page: { deliveryProfiles: Connection<RawProfile> } = await request(PROFILES_QUERY, {
      first: sizes.profiles,
      after: profilesAfter,
      zonesFirst: sizes.zones,
      ratesFirst: sizes.rates,
    });
    for (const profile of page.deliveryProfiles.nodes) {
      const groups: DeliveryProfileNode["profileLocationGroups"] = [];
      for (const group of profile.profileLocationGroups) {
        const nodes = await collectZones(profile.id, group.locationGroup.id, group.locationGroupZones);
        groups.push({ locationGroupZones: { nodes } });
      }
      profiles.push({ id: profile.id, profileLocationGroups: groups });
    }
    profilesAfter = nextCursor(page.deliveryProfiles.pageInfo, "deliveryProfiles");
  } while (profilesAfter);

  // --- Shop currency + automatic free-shipping discounts ---
  let shopCurrency = "";
  const discounts: DiscountFreeShipping[] = [];
  let blocksShipping = false;
  let discountsAfter: string | null = null;
  do {
    const page: { shop: { currencyCode: string }; discountNodes: Connection<{ discount: DiscountFreeShipping }> } =
      await request(DISCOUNTS_QUERY, { first: sizes.discounts, after: discountsAfter });
    shopCurrency ||= page.shop.currencyCode;
    for (const { discount } of page.discountNodes.nodes) {
      if (discount.__typename === "DiscountAutomaticFreeShipping") {
        if (discount.status === "ACTIVE") discounts.push(discount);
      } else if (discount.combinesWith?.shippingDiscounts === false) {
        blocksShipping = true;
      }
    }
    discountsAfter = nextCursor(page.discountNodes.pageInfo, "discountNodes");
  } while (discountsAfter);

  return {
    data: {
      markets: { nodes: markets },
      deliveryProfiles: { nodes: profiles },
      shopCurrency,
      discounts: { nodes: discounts },
      blocksShipping,
    },
    costs,
  };
}
