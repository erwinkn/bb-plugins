import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWK } from "jose";
import { createAccessVerifier } from "../server/access-jwt";

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let verify: ReturnType<typeof createAccessVerifier>;
const config = { accessTeamDomain: "team.cloudflareaccess.com", accessAudience: "aud" };
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  verify = createAccessVerifier(createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: "key" }] }));
});
function jwt(email?: string) {
  return new SignJWT(email === undefined ? {} : { email }).setProtectedHeader({ alg: "RS256", kid: "key" })
    .setIssuer("https://team.cloudflareaccess.com").setAudience("aud");
}
describe("Access identity", () => {
  it("normalizes verified emails and allows a missing email claim", async () => {
    expect(await verify(await jwt(" PERSON@Example.com ").setSubject("person").setExpirationTime("1h").sign(keys.privateKey), config))
      .toEqual({ email: "person@example.com", subject: "person" });
    expect(await verify(await jwt().setSubject("service").setExpirationTime("1h").sign(keys.privateKey), config))
      .toEqual({ email: null, subject: "service" });
  });
  it("requires both an expiration and a subject", async () => {
    await expect(verify(await jwt().setSubject("person").sign(keys.privateKey), config)).rejects.toThrow();
    await expect(verify(await jwt().setExpirationTime("1h").sign(keys.privateKey), config)).rejects.toThrow();
  });
  it("refuses an otherwise valid RS384 token with a resolvable RSA key", async () => {
    const otherKeys = await generateKeyPair("RS384");
    const resolver = createLocalJWKSet({ keys: [{ ...await exportJWK(otherKeys.publicKey), kid: "other-rsa" }] });
    const token = await new SignJWT({ email: "person@example.com" }).setProtectedHeader({ alg: "RS384", kid: "other-rsa" })
      .setIssuer(`https://${config.accessTeamDomain}`).setAudience(config.accessAudience)
      .setSubject("person").setExpirationTime("1h").sign(otherKeys.privateKey);
    // Prove signature, key resolution, and claims pass without the algorithm restriction.
    await expect(jwtVerify(token, resolver, { issuer: `https://${config.accessTeamDomain}`, audience: config.accessAudience, requiredClaims: ["exp", "sub"] }))
      .resolves.toMatchObject({ payload: { sub: "person", email: "person@example.com" } });
    await expect(createAccessVerifier(resolver)(token, config)).rejects.toMatchObject({ code: "ERR_JOSE_ALG_NOT_ALLOWED" });
  });
  it("refuses malformed configuration", async () => {
    const token = await jwt().setSubject("person").setExpirationTime("1h").sign(keys.privateKey);
    await expect(verify(token, { ...config, accessAudience: "" })).rejects.toThrow("not configured");
    await expect(verify(token, { ...config, accessTeamDomain: "team.cloudflareaccess.com/evil" })).rejects.toThrow("not configured");
  });
});

describe("remote JWKS cache", () => {
  let rotatedKeys: Awaited<ReturnType<typeof generateKeyPair>>;
  let initialJwk: JWK;
  let rotatedJwk: JWK;
  let remoteVerify: ReturnType<typeof createAccessVerifier>;
  const fetchJwks = vi.fn<typeof fetch>();
  beforeAll(async () => {
    rotatedKeys = await generateKeyPair("RS256");
    initialJwk = { ...await exportJWK(keys.publicKey), kid: "key" };
    rotatedJwk = { ...await exportJWK(rotatedKeys.publicKey), kid: "rotated" };
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T00:00:00Z"));
    fetchJwks.mockReset().mockImplementation(async () => Response.json({ keys: [initialJwk] }));
    vi.stubGlobal("fetch", fetchJwks);
    remoteVerify = createAccessVerifier();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  function sign(kid = "key", domain = config.accessTeamDomain) {
    return new SignJWT({ email: "PERSON@Example.com" }).setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(`https://${domain}`).setAudience(config.accessAudience)
      .setSubject("person").setExpirationTime("1h").sign(kid === "rotated" ? rotatedKeys.privateKey : keys.privateKey);
  }
  it("reuses the cached key set within the cooldown", async () => {
    const token = await sign();
    expect(await remoteVerify(token, config)).toEqual({ email: "person@example.com", subject: "person" });
    await vi.advanceTimersByTimeAsync(29_999);
    await remoteVerify(token, config);
    expect(fetchJwks).toHaveBeenCalledTimes(1);
    expect(fetchJwks.mock.calls[0]?.[0]).toBe("https://team.cloudflareaccess.com/cdn-cgi/access/certs");
  });
  it("suppresses unknown-key refetches during cooldown and retries after it expires", async () => {
    await remoteVerify(await sign(), config);
    const rotated = await sign("rotated");
    fetchJwks.mockImplementation(async () => Response.json({ keys: [initialJwk, rotatedJwk] }));
    await vi.advanceTimersByTimeAsync(29_999);
    await expect(remoteVerify(rotated, config)).rejects.toMatchObject({ code: "ERR_JWKS_NO_MATCHING_KEY" });
    expect(fetchJwks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(remoteVerify(rotated, config)).resolves.toEqual({ email: "person@example.com", subject: "person" });
    expect(fetchJwks).toHaveBeenCalledTimes(2);
    await remoteVerify(rotated, config);
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });
  it("refetches a still-fresh set for an unknown key id after cooldown, and rejects an absent key", async () => {
    await remoteVerify(await sign(), config);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(remoteVerify(await sign("unknown"), config)).rejects.toMatchObject({ code: "ERR_JWKS_NO_MATCHING_KEY" });
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });
  it("keeps known keys after cooldown and refetches when the ten-minute cache expires", async () => {
    const token = await sign();
    await remoteVerify(token, config);
    await vi.advanceTimersByTimeAsync(30_000);
    await remoteVerify(token, config);
    await vi.advanceTimersByTimeAsync(569_999);
    await remoteVerify(token, config);
    expect(fetchJwks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await remoteVerify(token, config);
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });
  it("creates a fresh resolver when the team domain changes, even during cooldown", async () => {
    const first = await sign();
    await remoteVerify(first, config);
    const nextConfig = { ...config, accessTeamDomain: "other.cloudflareaccess.com" };
    fetchJwks.mockImplementation(async () => Response.json({ keys: [rotatedJwk] }));
    await expect(remoteVerify(await sign("rotated", nextConfig.accessTeamDomain), nextConfig)).resolves.toMatchObject({ subject: "person" });
    fetchJwks.mockImplementation(async () => Response.json({ keys: [initialJwk] }));
    await remoteVerify(first, config);
    expect(fetchJwks.mock.calls.map(([url]) => url)).toEqual([
      "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
      "https://other.cloudflareaccess.com/cdn-cgi/access/certs",
      "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    ]);
  });
});
