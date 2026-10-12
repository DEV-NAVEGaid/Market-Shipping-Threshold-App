import { NextResponse, type NextRequest } from "next/server";
import { escapeHtml, normalizeShop, safeEqual, STATE_COOKIE, verifyAdminHmac } from "@/lib/oauth";

// Completes the install: exchanges the code for an offline access token (no `expiring`
// param, so it doesn't expire) and shows it once. Nothing is stored server-side.
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const apiKey = process.env.SHOPIFY_API_KEY;
  const secret = process.env.SHOPIFY_API_SECRET;

  if (!apiKey || !secret) return text(500, "App not configured");
  if (!verifyAdminHmac(params, secret)) return text(401, "Invalid HMAC");

  const shop = normalizeShop(params.get("shop"));
  if (!shop) return text(400, "Invalid shop");

  if (!safeEqual(params.get("state") ?? "", req.cookies.get(STATE_COOKIE)?.value ?? "")) {
    return text(401, "Invalid state — restart the install from /api/auth?shop=<shop>");
  }

  const code = params.get("code");
  if (!code) return text(400, "Missing code");

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: apiKey, client_secret: secret, code }),
  });
  const json = res.ok
    ? ((await res.json().catch(() => null)) as { access_token?: string; scope?: string } | null)
    : null;
  if (!json?.access_token) {
    console.error("oauth: token exchange failed", res.status); // never log the body or token
    return text(502, "Token exchange failed");
  }

  return clearState(
    new NextResponse(tokenPage(shop, json.scope ?? "", json.access_token), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    }),
  );
}

function clearState(res: NextResponse) {
  res.cookies.set(STATE_COOKIE, "", { path: "/api/auth", maxAge: 0 });
  return res;
}

function text(status: number, body: string) {
  return clearState(
    new NextResponse(body, {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    }),
  );
}

function tokenPage(shop: string, scope: string, token: string): string {
  const s = escapeHtml(shop);
  const t = escapeHtml(token);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>App installed</title>
</head>
<body style="font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5">
<h1>App installed</h1>
<p>Store: <strong>${s}</strong><br>Granted scopes: <code>${escapeHtml(scope)}</code></p>
<label for="token"><strong>Admin API access token</strong> (shown only once — copy it now):</label>
<textarea id="token" readonly rows="2" style="width: 100%; font-family: monospace">${t}</textarea>
<h2>Next steps</h2>
<ol>
<li>Open Vercel → this project → Settings → Environment Variables.</li>
<li>Set <code>SHOPIFY_ADMIN_TOKEN</code> to the token above (Production).</li>
<li>Set <code>SHOPIFY_STORE_DOMAIN</code> to <code>${s}</code> (Production).</li>
<li>Redeploy the project so the new values take effect.</li>
</ol>
<p><strong>Do not share this token.</strong> It gives read access to the store's markets and shipping settings and does not expire. If it leaks, uninstall and reinstall the app to get a new one.</p>
</body>
</html>`;
}
