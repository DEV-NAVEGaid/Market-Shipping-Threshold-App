import crypto from "node:crypto";

// Canonical string per Shopify: decoded values, sorted by key, repeated keys joined with ",",
// all concatenated with no separator. Matches @shopify/shopify-api stringifyQueryForAppProxy.
export function appProxyCanonical(params: URLSearchParams): string {
  const grouped = new Map<string, string[]>();
  for (const [key, value] of params) {
    if (key === "signature") continue;
    const values = grouped.get(key) ?? [];
    values.push(value);
    grouped.set(key, values);
  }
  return [...grouped.keys()]
    .sort()
    .map((key) => `${key}=${grouped.get(key)!.join(",")}`)
    .join("");
}

export function proxySignature(params: URLSearchParams, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(appProxyCanonical(params), "utf8")
    .digest("hex");
}

export function verifyProxySignature(params: URLSearchParams, secret: string): boolean {
  const provided = params.get("signature");
  if (!provided) return false;
  const expected = proxySignature(params, secret);
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
