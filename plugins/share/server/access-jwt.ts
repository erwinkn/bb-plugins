import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AccessIdentity { email: string | null; subject: string }
export interface AccessConfig { accessTeamDomain: string; accessAudience: string }
export type AccessVerifier = (token: string, config: AccessConfig) => Promise<AccessIdentity>;

/** The optional resolver keeps tests offline while exercising real JWT verification. */
export function createAccessVerifier(keyResolver?: JWTVerifyGetKey): AccessVerifier {
  let cachedDomain: string | undefined;
  let cachedResolver: JWTVerifyGetKey | undefined;
  return async (token, config) => {
    const domain = config.accessTeamDomain.trim().toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain) || !config.accessAudience.trim()) {
      throw new Error("Cloudflare Access is not configured.");
    }
    if (!keyResolver && cachedDomain !== domain) {
      cachedDomain = domain;
      cachedResolver = createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`), {
        cacheMaxAge: 600_000, cooldownDuration: 30_000, timeoutDuration: 5_000,
      });
    }
    const { payload } = await jwtVerify(token, keyResolver ?? cachedResolver!, {
      issuer: `https://${domain}`, audience: config.accessAudience.trim(), algorithms: ["RS256"],
      requiredClaims: ["exp", "sub"],
    });
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Missing Access subject.");
    return { email: typeof payload.email === "string" ? payload.email.trim().toLowerCase() : null, subject: payload.sub };
  };
}
