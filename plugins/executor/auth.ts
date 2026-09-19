// Credential handling for the Executor MCP gateway. Two credential types are
// supported and sent on every request:
//
//   a) OAuth — `accessToken` sent as `Authorization: Bearer <token>`. CF Access
//      access tokens live ~15 minutes, so when `refreshToken` + `clientId` +
//      `clientSecret` are also configured the plugin refreshes through the
//      token endpoint (refresh_token grant, client_secret_basic) and persists
//      rotated tokens back into the plugin's secret settings.
//   b) Service token — `cfAccessClientId` + `cfAccessClientSecret` sent as
//      CF-Access-Client-Id / CF-Access-Client-Secret headers.
//
// Both may be configured at once; whichever the gateway accepts wins.

export interface ExecutorCredentials {
  endpointUrl: string;
  tokenEndpoint: string;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

/** Minimal kv surface (bb.storage.kv satisfies it) holding the token expiry. */
export interface ExpiryStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

const EXPIRY_KEY = "oauth.accessTokenExpiresAt";
// Refresh this far ahead of the stated expiry: a stale-token 401 mid-call is
// the norm with 15-minute tokens, not the exception.
const EXPIRY_MARGIN_MS = 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ExecutorAuth {
  private refreshing: Promise<boolean> | null = null;
  private expiresAt: number | null = null;
  private expiryLoaded = false;

  constructor(
    private readonly load: () => Promise<ExecutorCredentials>,
    private readonly persist: (
      patch: { accessToken?: string | null; refreshToken?: string | null },
    ) => Promise<void>,
    private readonly store: ExpiryStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** True when at least one complete credential is configured. */
  configured(creds: ExecutorCredentials): boolean {
    return Boolean(
      creds.accessToken?.trim() ||
        (creds.cfAccessClientId?.trim() && creds.cfAccessClientSecret?.trim()),
    );
  }

  /** Names of the credential fields currently set (never values). */
  describe(creds: ExecutorCredentials): string[] {
    const fields: string[] = [];
    for (const key of [
      "accessToken",
      "refreshToken",
      "clientId",
      "clientSecret",
      "cfAccessClientId",
      "cfAccessClientSecret",
    ] as const) {
      if (creds[key]?.trim()) fields.push(key);
    }
    return fields;
  }

  /** Headers for one gateway request. Refreshes proactively when the
   *  persisted expiry is near and a refresh token is available. */
  async headers(signal?: AbortSignal): Promise<Record<string, string>> {
    const creds = await this.load();
    if (
      creds.accessToken?.trim() &&
      creds.refreshToken?.trim() &&
      creds.clientId?.trim() &&
      (await this.expired())
    ) {
      await this.refresh(signal);
    }
    const next = await this.load();
    const headers: Record<string, string> = {};
    if (next.accessToken?.trim()) headers["authorization"] = `Bearer ${next.accessToken.trim()}`;
    const cfId = next.cfAccessClientId?.trim();
    const cfSecret = next.cfAccessClientSecret?.trim();
    if (cfId && cfSecret) {
      headers["CF-Access-Client-Id"] = cfId;
      headers["CF-Access-Client-Secret"] = cfSecret;
    }
    return headers;
  }

  /** Run the refresh_token grant once (deduplicated across concurrent calls).
   *  Returns true when a new access token was obtained and persisted. */
  async refresh(signal?: AbortSignal): Promise<boolean> {
    this.refreshing ??= this.doRefresh(signal).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async expired(): Promise<boolean> {
    if (!this.expiryLoaded) {
      this.expiryLoaded = true;
      const stored = await this.store.get<number>(EXPIRY_KEY).catch(() => undefined);
      if (typeof stored === "number") this.expiresAt = stored;
    }
    return this.expiresAt !== null && Date.now() >= this.expiresAt - EXPIRY_MARGIN_MS;
  }

  private async doRefresh(signal?: AbortSignal): Promise<boolean> {
    const creds = await this.load();
    const refreshToken = creds.refreshToken?.trim();
    const clientId = creds.clientId?.trim();
    if (!refreshToken || !clientId) return false;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    const clientSecret = creds.clientSecret?.trim();
    if (clientSecret) {
      // The registered client uses token_endpoint_auth_method=client_secret_basic.
      headers["authorization"] = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
    } else {
      body.set("client_id", clientId);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(creds.tokenEndpoint, {
        method: "POST",
        headers,
        body: body.toString(),
        signal: signal ?? null,
      });
    } catch (error) {
      this.log(`executor token refresh request failed: ${errorMessage(error)}`);
      return false;
    }
    if (!res.ok) {
      this.log(`executor token refresh rejected: HTTP ${res.status}`);
      return false;
    }
    const data = (await res.json().catch(() => null)) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    } | null;
    const accessToken = typeof data?.access_token === "string" ? data.access_token : "";
    if (!accessToken) {
      this.log("executor token refresh returned no access_token");
      return false;
    }
    const rotated =
      typeof data?.refresh_token === "string" && data.refresh_token ? data.refresh_token : undefined;
    await this.persist({ accessToken, ...(rotated ? { refreshToken: rotated } : {}) });
    if (typeof data?.expires_in === "number" && data.expires_in > 0) {
      this.expiresAt = Date.now() + data.expires_in * 1000;
      this.expiryLoaded = true;
      await this.store.set(EXPIRY_KEY, this.expiresAt).catch(() => {});
    }
    return true;
  }
}
