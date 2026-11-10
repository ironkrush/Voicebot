import "server-only";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export type LimitResult = { ok: true } | { ok: false; retryAfter: number };

const PER_MINUTE = 10;
const PER_DAY = 100;
const DEFAULT_GLOBAL_DAILY = 1500;

const globalDailyCap = () => {
  const n = Number(process.env.GLOBAL_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_GLOBAL_DAILY;
};

// ---------- Upstash (shared across serverless instances) ----------
type Upstash = { minute: Ratelimit; day: Ratelimit; global: Ratelimit };
let upstash: Upstash | null | undefined;

function getUpstash(): Upstash | null {
  if (upstash !== undefined) return upstash;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return (upstash = null);
  const redis = new Redis({ url, token });
  upstash = {
    minute: new Ratelimit({ redis, prefix: "vb:min", limiter: Ratelimit.slidingWindow(PER_MINUTE, "1 m") }),
    day: new Ratelimit({ redis, prefix: "vb:day", limiter: Ratelimit.fixedWindow(PER_DAY, "1 d") }),
    global: new Ratelimit({ redis, prefix: "vb:global", limiter: Ratelimit.fixedWindow(globalDailyCap(), "1 d") }),
  };
  return upstash;
}

// ---------- In-memory fallback (best effort, per instance) ----------
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
const MAX_KEYS = 10_000;

export function memoryHit(key: string, limit: number, windowMs: number, now = Date.now()): LimitResult {
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    if (buckets.size >= MAX_KEYS) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
      if (buckets.size >= MAX_KEYS) buckets.clear();
    }
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > limit) return { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  return { ok: true };
}

export function resetMemoryLimiter() {
  buckets.clear();
}

/** Applies per-IP minute/day limits plus a global daily cap. */
export async function checkRateLimit(ip: string): Promise<LimitResult> {
  const u = getUpstash();
  if (u) {
    try {
      for (const [lim, key] of [
        [u.minute, ip],
        [u.day, ip],
        [u.global, "all"],
      ] as const) {
        const r = await lim.limit(key);
        if (!r.success) return { ok: false, retryAfter: Math.max(1, Math.ceil((r.reset - Date.now()) / 1000)) };
      }
      return { ok: true };
    } catch {
      // Redis unavailable: fall through to in-memory limiting rather than failing open.
    }
  }
  const checks: LimitResult[] = [
    memoryHit(`m:${ip}`, PER_MINUTE, 60_000),
    memoryHit(`d:${ip}`, PER_DAY, 86_400_000),
    memoryHit("g:all", globalDailyCap(), 86_400_000),
  ];
  return checks.find((c) => !c.ok) ?? { ok: true };
}
