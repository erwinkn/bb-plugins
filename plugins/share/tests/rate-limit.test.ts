import { describe, expect, it } from "vitest";
import { clientIp, RateLimiter } from "../server/rate-limit";

describe("IP buckets", () => {
  it("uses Cloudflare, then first forwarded IP, then socket, then unknown", () => {
    const req = (headers: Record<string, string>) => new Request("http://local/", { headers });
    expect(clientIp(req({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8, 9.0.0.1" }), "socket")).toBe("1.2.3.4");
    expect(clientIp(req({ "x-forwarded-for": "5.6.7.8, 9.0.0.1" }), "socket")).toBe("5.6.7.8");
    expect(clientIp(req({}), "socket")).toBe("socket"); expect(clientIp(req({}))).toBe("unknown");
  });
  it("bounds memory without evicting live limits, then prunes idle clients", () => {
    let now = 0; const limiter = new RateLimiter(() => now, 1);
    for (let i = 0; i < 60; i++) expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false); expect(limiter.take("b")).toBe(false);
    now += 60_000; expect(limiter.take("b")).toBe(true);
    limiter.clear(); expect(limiter.take("a")).toBe(true);
  });
});
