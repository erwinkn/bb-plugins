import { beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
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
  it("refuses algorithms other than RS256 and malformed configuration", async () => {
    const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).sign(new Uint8Array(32));
    await expect(verify(token, config)).rejects.toThrow();
    await expect(verify(token, { ...config, accessAudience: "" })).rejects.toThrow("not configured");
    await expect(verify(token, { ...config, accessTeamDomain: "team.cloudflareaccess.com/evil" })).rejects.toThrow("not configured");
  });
});
