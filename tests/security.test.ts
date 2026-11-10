import { beforeEach, describe, expect, it } from "vitest";
import { clientIp, isAllowedOrigin } from "@/lib/security";
import { memoryHit, resetMemoryLimiter } from "@/lib/ratelimit";

const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
const dev = { NODE_ENV: "development" } as NodeJS.ProcessEnv;
const h = (o: Record<string, string>) => new Headers(o);

describe("isAllowedOrigin", () => {
  it("allows same-origin https in production", () => {
    expect(isAllowedOrigin(h({ host: "bot.vercel.app", origin: "https://bot.vercel.app" }), prod)).toBe(true);
  });
  it("rejects other origins, missing origin, http and localhost in production", () => {
    expect(isAllowedOrigin(h({ host: "bot.vercel.app", origin: "https://evil.com" }), prod)).toBe(false);
    expect(isAllowedOrigin(h({ host: "bot.vercel.app" }), prod)).toBe(false);
    expect(isAllowedOrigin(h({ host: "bot.vercel.app", origin: "http://bot.vercel.app" }), prod)).toBe(false);
    expect(isAllowedOrigin(h({ host: "bot.vercel.app", origin: "http://localhost:3000" }), prod)).toBe(false);
    expect(isAllowedOrigin(h({ host: "bot.vercel.app", origin: "https://bot.vercel.app.evil.com" }), prod)).toBe(false);
  });
  it("rejects cross-site fetch metadata even with a matching origin", () => {
    const headers = h({ host: "bot.vercel.app", origin: "https://bot.vercel.app", "sec-fetch-site": "cross-site" });
    expect(isAllowedOrigin(headers, prod)).toBe(false);
  });
  it("allows localhost in development", () => {
    expect(isAllowedOrigin(h({ host: "localhost:3000", origin: "http://localhost:3000" }), dev)).toBe(true);
  });
  it("honours ALLOWED_ORIGINS", () => {
    const env = { ...prod, ALLOWED_ORIGINS: "https://krushil.dev/ , https://x.y" } as NodeJS.ProcessEnv;
    expect(isAllowedOrigin(h({ host: "bot.vercel.app", origin: "https://krushil.dev" }), env)).toBe(true);
  });
});

describe("clientIp", () => {
  it("takes the first forwarded hop", () => {
    expect(clientIp(h({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe("1.2.3.4");
    expect(clientIp(h({}))).toBe("unknown");
  });
});

describe("memory rate limiter", () => {
  beforeEach(() => resetMemoryLimiter());
  it("blocks after the limit and resets after the window", () => {
    const t = 1_000_000;
    for (let i = 0; i < 10; i++) expect(memoryHit("ip", 10, 60_000, t).ok).toBe(true);
    const blocked = memoryHit("ip", 10, 60_000, t + 1000);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfter).toBe(59);
    expect(memoryHit("ip", 10, 60_000, t + 60_001).ok).toBe(true);
  });
});
