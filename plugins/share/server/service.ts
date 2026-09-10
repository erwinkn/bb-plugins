import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { matches, normalizeEntries } from "../lib/allow";
import { createSchema, updateSchema, shareRefSchema, expiryDaysSchema, type Status, type Visibility } from "../lib/model";
import { renderPage, renderStatusPage } from "../lib/render";
import { ShareStore, shareState, toShare } from "./store";
import { createAccessVerifier, type AccessVerifier } from "./access-jwt";
import { RateLimiter, clientIp } from "./rate-limit";
import { readTimeline } from "./timeline";

export interface ShareSettings {
  publicBaseUrl: string; publicLinksEnabled: boolean; defaultExpiryDays: number;
  accessTeamDomain: string; accessAudience: string; requireAccessJwt: boolean;
}
export function normalizeBaseUrl(value: string): string {
  const input = value.trim();
  if (!input) return "";
  try {
    const url = new URL(input);
    if (!/^https?:\/\/[^/?#]+\/?$/i.test(input) || !["http:", "https:"].includes(url.protocol)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new Error("publicBaseUrl must be an http:// or https:// origin with no path, credentials, query, or fragment."); }
}
export const baseUrlSchema = z.string().refine((value) => {
  try { normalizeBaseUrl(value); return true; } catch { return false; }
}, "Use an http:// or https:// origin with no path.");

export function configuration(settings: ShareSettings): Status {
  const base = normalizeBaseUrl(settings.publicBaseUrl);
  const missing = [
    ...(!base ? ["publicBaseUrl"] : []),
    ...(!settings.accessTeamDomain.trim() ? ["accessTeamDomain"] : []),
    ...(!settings.accessAudience.trim() ? ["accessAudience"] : []),
  ];
  return {
    configured: Boolean(base), accessConfigured: Boolean(settings.accessTeamDomain.trim() && settings.accessAudience.trim()),
    publicBaseUrl: base || null, publicLinksEnabled: settings.publicLinksEnabled,
    defaultExpiryDays: expiryDaysSchema.parse(settings.defaultExpiryDays), missing,
  };
}

export const SECURITY_HEADERS = {
  "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
};
export const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'";
function response(status: number, body: string, html = false, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: {
    ...SECURITY_HEADERS, "content-type": html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
    ...(html ? { "content-security-policy": CSP } : {}), ...extra,
  } });
}

export class ShareService {
  private readonly now: () => number;
  private readonly verifyAccess: AccessVerifier;
  readonly limiter: RateLimiter;
  constructor(readonly store: ShareStore, private readonly deps: {
    settings: () => Promise<ShareSettings>;
    threads: BbPluginApi["sdk"]["threads"];
    publish: (signal: { threadId: string }) => void;
    log: BbPluginApi["log"];
    verifyAccess?: AccessVerifier;
    now?: () => number;
  }) {
    this.now = deps.now ?? Date.now;
    this.verifyAccess = deps.verifyAccess ?? createAccessVerifier();
    this.limiter = new RateLimiter(this.now);
  }

  async status(): Promise<Status> { return configuration(await this.deps.settings()); }
  async list(threadId: string) {
    const status = await this.status();
    return { shares: this.store.list(threadId).map((share) => toShare(share, status.publicBaseUrl ?? "", this.now())) };
  }
  async create(input: unknown) {
    const parsed = createSchema.parse(input);
    const status = await this.status();
    if (!status.configured) throw new Error("Set publicBaseUrl before creating a share.");
    if (parsed.visibility === "public" && !status.publicLinksEnabled) throw new Error("Public links are disabled (publicLinksEnabled).");
    if (parsed.visibility === "access" && !status.accessConfigured) throw new Error("Set accessTeamDomain and accessAudience before creating an Access share.");
    // Resolve existence before persisting a link to a nonexistent thread.
    await this.deps.threads.get({ threadId: parsed.threadId });
    const days = parsed.expiresInDays === undefined ? status.defaultExpiryDays : parsed.expiresInDays;
    const now = this.now();
    const share = this.store.create({
      threadId: parsed.threadId, visibility: parsed.visibility,
      allowedEmails: parsed.allowedEmails ?? [], includeTools: parsed.includeTools ?? false,
      expiresAt: days ? now + Math.round(days * 86_400_000) : null, now,
    });
    this.deps.publish({ threadId: parsed.threadId });
    return { share: toShare(share, status.publicBaseUrl!, now) };
  }
  async update(input: unknown) {
    const parsed = updateSchema.parse(input);
    const status = await this.status();
    const share = this.store.update(parsed.threadId, parsed.shareId, parsed);
    this.deps.publish({ threadId: parsed.threadId });
    return { share: toShare(share, status.publicBaseUrl ?? "", this.now()) };
  }
  async revoke(input: unknown) {
    const parsed = shareRefSchema.parse(input);
    const status = await this.status();
    const share = this.store.revoke(parsed.threadId, parsed.shareId, this.now());
    this.deps.publish({ threadId: parsed.threadId });
    return { share: toShare(share, status.publicBaseUrl ?? "", this.now()) };
  }
  async changeAllow(shareId: string, entries: string[], remove: boolean) {
    const normalized = normalizeEntries(entries);
    const status = await this.status();
    const current = this.store.get(shareId);
    if (!current) throw new Error("Unknown share.");
    const allowedEmails = remove ? current.allowedEmails.filter((entry) => !normalized.includes(entry))
      : normalizeEntries([...current.allowedEmails, ...normalized]);
    const parsed = updateSchema.parse({ threadId: current.threadId, shareId, allowedEmails });
    const share = this.store.update(current.threadId, shareId, parsed);
    this.deps.publish({ threadId: current.threadId });
    return { share: toShare(share, status.publicBaseUrl ?? "", this.now()) };
  }
  revokeThread(threadId: string): void {
    if (this.store.revokeThread(threadId, this.now()) > 0) this.deps.publish({ threadId });
  }

  async handle(request: Request, mode: Visibility, socketAddress?: string): Promise<Response> {
    if (!this.limiter.take(clientIp(request, socketAddress))) return response(429, "too many requests", false, { "retry-after": "60" });
    try {
      const settings = await this.deps.settings();
      const status = configuration(settings);
      if (!status.configured) return response(503, "share plugin is not configured");
      const slug = new URL(request.url).searchParams.get("k");
      if (!slug || !/^[A-Za-z0-9_-]{40,48}$/.test(slug)) return response(404, "not found");
      let email: string | null = null;
      if (mode === "access" && settings.requireAccessJwt) {
        const token = request.headers.get("cf-access-jwt-assertion");
        if (!token) return response(401, renderStatusPage("signin"), true);
        try { email = (await this.verifyAccess(token, settings)).email; }
        catch { return response(401, renderStatusPage("signin"), true); }
      }
      const share = this.store.lookup(slug);
      if (!share || share.visibility !== mode || shareState(share, this.now()) !== "active") return response(404, "not found");
      if (mode === "public" && !settings.publicLinksEnabled) return response(404, "not found");
      if (mode === "access" && !matches(share.allowedEmails, email)) return response(403, renderStatusPage("forbidden", { email }), true);
      this.store.recordView(share.id, this.now());
      this.deps.publish({ threadId: share.threadId });
      const timeline = await readTimeline(this.deps.threads, share.threadId, share.includeTools);
      return response(200, renderPage({ ...timeline, mode, unverified: mode === "access" && !settings.requireAccessJwt, generatedAt: this.now() }), true);
    } catch {
      // Do not log the request URL, slug, JWT, or thread content on failure.
      this.deps.log.error("Could not render a shared thread.");
      return response(500, "unable to render shared thread");
    }
  }
}
