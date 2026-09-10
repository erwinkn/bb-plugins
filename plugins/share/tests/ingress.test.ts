import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const rule = readme.match(/^    path: (.+)$/m)?.[1];
if (!rule) throw new Error("Missing tunnel ingress path rule in README");
const ingress = new RegExp(rule);
const prefix = "/api/v1/plugins/share/http";

// cloudflared uses Go's URL.Path: query excluded, path decoded, dot segments
// still present. WHATWG new URL() would normalize away this regression fixture.
const decodedPath = (target: string) => decodeURIComponent(target.split("?")[0]!);

describe("documented tunnel ingress", () => {
  it.each(["/s", "/p", "/s?k=slug", "/p?k=slug&extra=value"])("admits the exact share route %s", (suffix) => {
    expect(ingress.test(decodedPath(prefix + suffix))).toBe(true);
  });

  it.each([
    `${prefix}/p%3F/%2e%2e/%2e%2e/%2e%2e/%2e%2e/threads`,
    `${prefix}/p/../../../../threads`,
    `${prefix}/s%3F/../../../../threads`,
    `${prefix}/p%3F`, `${prefix}/p/`, `${prefix}/p/other`,
    "/api/v1/threads", "/api/v1/plugins/share/rpc/share_list",
  ])("rejects non-route path %s", (target) => {
    expect(ingress.test(decodedPath(target))).toBe(false);
  });
});
