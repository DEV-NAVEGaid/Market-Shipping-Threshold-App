import type { NextRequest } from "next/server";
import { verifyProxySignature } from "@/lib/verify";
import { getThresholdForMarket } from "@/lib/shipping";

export async function GET(req: NextRequest) {
  const secret = process.env.SHOPIFY_API_SECRET;
  const params = req.nextUrl.searchParams;

  if (!secret || !verifyProxySignature(params, secret)) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  const market = params.get("market");
  if (!market) {
    return Response.json({ error: "missing market param" }, { status: 400 });
  }

  try {
    const threshold = await getThresholdForMarket(market);
    return Response.json(threshold ?? { threshold: null, currency: null });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
