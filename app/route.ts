import { NextResponse, type NextRequest } from "next/server";
import { normalizeShop, verifyAdminHmac } from "@/lib/oauth";

// application_url. Shopify opens it with ?shop=&hmac=&timestamp=&host= after install;
// a verified request continues to the OAuth flow, anything else gets an info page.
export function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  if (params.has("hmac")) {
    const shop = normalizeShop(params.get("shop"));
    const secret = process.env.SHOPIFY_API_SECRET ?? "";
    if (!shop || !verifyAdminHmac(params, secret)) {
      return new Response("Invalid HMAC", {
        status: 401,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    // Already installed (token configured for this shop): don't re-run OAuth and
    // re-display the token on every admin open. Remove SHOPIFY_ADMIN_TOKEN to reinstall.
    const configuredShop = normalizeShop(process.env.SHOPIFY_STORE_DOMAIN);
    if (process.env.SHOPIFY_ADMIN_TOKEN?.trim() && configuredShop === shop) {
      return infoPage();
    }
    const res = NextResponse.redirect(new URL(`/api/auth?shop=${encodeURIComponent(shop)}`, req.nextUrl));
    res.headers.set("Cache-Control", "no-store");
    return res;
  }

  return infoPage();
}

function infoPage() {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Market Shipping Threshold</title>
</head>
<body style="font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5">
<h1>Market Shipping Threshold</h1>
<p>This app serves free-shipping thresholds to the storefront via the app proxy. Nothing to configure here.</p>
</body>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}
