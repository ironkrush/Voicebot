import "server-only";

/** Builds the set of allowed origins for this deployment. */
export function allowedOrigins(headers: Headers, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const set = new Set<string>();
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (host) {
    set.add(`https://${host}`);
    if (env.NODE_ENV !== "production") set.add(`http://${host}`);
  }
  for (const v of [env.VERCEL_URL, env.VERCEL_PROJECT_PRODUCTION_URL, env.VERCEL_BRANCH_URL]) {
    if (v) set.add(`https://${v}`);
  }
  for (const o of (env.ALLOWED_ORIGINS ?? "").split(",")) {
    const t = o.trim().replace(/\/+$/, "");
    if (t) set.add(t);
  }
  if (env.NODE_ENV !== "production") {
    for (const p of ["3000", "3001"]) {
      set.add(`http://localhost:${p}`);
      set.add(`http://127.0.0.1:${p}`);
    }
  }
  return set;
}

/** Rejects requests whose Origin header is missing or not this site. */
export function isAllowedOrigin(headers: Headers, env: NodeJS.ProcessEnv = process.env): boolean {
  const origin = headers.get("origin");
  if (!origin) return false;
  // Browsers also send Sec-Fetch-Site; a cross-site value is an immediate reject.
  const site = headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  return allowedOrigins(headers, env).has(origin.replace(/\/+$/, ""));
}

/** Client IP. On Vercel, x-forwarded-for is set by the platform; take the first hop. */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim() || "unknown";
  return headers.get("x-real-ip")?.trim() || "unknown";
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

export const BUSY_MESSAGE = "The bot is busy, try again in a few seconds.";
export const GENERIC_ERROR = "Something went wrong on my side. Please try again.";
