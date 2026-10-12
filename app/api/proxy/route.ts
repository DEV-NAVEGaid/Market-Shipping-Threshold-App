import type { NextRequest } from "next/server";
import { verifyProxySignature } from "@/lib/verify";
import { normalizeShop } from "@/lib/oauth";
import { parseCartBody } from "@/lib/cart";
import {
  evaluateCartForCountry,
  getThresholdForCountry,
  getThresholdForMarket,
  parseLookup,
  storeDomain,
} from "@/lib/shipping";

const MAX_BODY_BYTES = 16_384;

function fail(status: number, error: string) {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

// App Proxy signature + single-store check. Returns an error response, or null when allowed.
function authorize(params: URLSearchParams): Response | null {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret || !verifyProxySignature(params, secret)) return fail(401, "invalid signature");
  // Single-store app: a validly signed request for any other shop is rejected.
  if (normalizeShop(params.get("shop")) !== storeDomain()) return fail(403, "unknown shop");
  return null;
}

// Legacy/debug: threshold for a country (?country=XX) or market handle (?market=).
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  try {
    const denied = authorize(params);
    if (denied) return denied;

    // ?country=XX (active storefront country) wins over the legacy ?market=.
    const lookup = parseLookup(params);
    if (lookup.kind === "error") return fail(400, lookup.error);

    const threshold =
      lookup.kind === "country" ? await getThresholdForCountry(lookup.code) : await getThresholdForMarket(lookup.key);
    return Response.json(threshold ?? { threshold: null, currency: null }, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  } catch (error) {
    console.error("proxy: threshold lookup failed", error instanceof Error ? error.message : error);
    return fail(500, "internal error");
  }
}

// Theme contract: POST ?country=XX with { currency, rate, total, variant_ids } -> cart free-shipping state.
export async function POST(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  try {
    const denied = authorize(params);
    if (denied) return denied;

    const lookup = parseLookup(params);
    if (lookup.kind !== "country") return fail(400, "invalid country param");

    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return fail(413, "body too large");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return fail(400, "invalid json");
    }
    const body = parseCartBody(raw);
    if (!body.ok) return fail(400, body.error);

    const result = await evaluateCartForCountry(lookup.code, body.value);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("proxy: cart evaluation failed", error instanceof Error ? error.message : error);
    return fail(500, "internal error");
  }
}
