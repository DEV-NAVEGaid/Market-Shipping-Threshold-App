export function GET() {
  return new Response(
    "Market Shipping Threshold installed. This app only serves the storefront threshold proxy; no account setup is needed here.",
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}
