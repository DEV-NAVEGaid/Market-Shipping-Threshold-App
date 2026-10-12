import { NextResponse, type NextRequest } from "next/server";
import { authorizeUrl, callbackUrl, newState, normalizeShop, STATE_COOKIE } from "@/lib/oauth";

// Starts the authorization code grant for an offline (non-expiring) token.
export function GET(req: NextRequest) {
  const shop = normalizeShop(req.nextUrl.searchParams.get("shop"));
  if (!shop) return text(400, "Invalid shop");

  const apiKey = process.env.SHOPIFY_API_KEY;
  if (!apiKey) return text(500, "App not configured");

  const state = newState();
  const redirectUri = callbackUrl(process.env.SHOPIFY_APP_URL, req.nextUrl.origin);
  const res = NextResponse.redirect(authorizeUrl(shop, apiKey, redirectUri, state));
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "lax",
    path: "/api/auth",
    maxAge: 600,
  });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

function text(status: number, body: string) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
