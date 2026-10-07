import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomBytes } from "node:crypto";
import type { Profile, ReasoningLevel } from "./schema";

// Thin, typed helpers over the public BB SDK.

export type Sdk = BbPluginApi["sdk"];
export type ThreadDto = Awaited<ReturnType<Sdk["threads"]["get"]>>;
/**
 * A `threads.list` row. Unlike the GET/event DTO it carries the full native
 * activity counts — background agents AND commands, workflows, goals — plus
 * the queue summary, so it is the supported evidence for "can this thread
 * still execute anything" once a turn looks quiet.
 */
export type ThreadListRow = Awaited<ReturnType<Sdk["threads"]["list"]>>[number];

/** A rejection the caller should read and act on; never retried. */
export class ProjectError extends Error {
  override name = "ProjectError";
}

export const newOpId = () => `op_${randomBytes(6).toString("hex")}`;
export const newProjectId = () => `prj_${randomBytes(5).toString("hex")}`;

/**
 * A 4xx (other than timeout or rate limit) means BB refused the request and
 * nothing happened. Anything else may or may not have taken effect.
 */
export function isDefiniteRejection(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const textInput = (text: string) => [
  { type: "text" as const, text, mentions: [] },
];

export const BUSY_STATUSES = new Set(["active", "starting", "stopping"]);

/**
 * How a child's turn ends reach its parent, in our BB fork (W203). "explicit" (final reports
 * only): never; the parent hears the child's own messages, needs-input and one notice when the
 * child stops without having messaged it. A server without the fork omits the field: null.
 */
export type ParentNotices = "turns" | "explicit";
export const parentNoticesOf = (thread: ThreadDto): ParentNotices | null =>
  "parentNotices" in thread && (thread.parentNotices === "turns" || thread.parentNotices === "explicit")
    ? thread.parentNotices
    : null;

/** The machine whose catalog decides availability: the project's default source. */
export async function projectHostId(
  sdk: Sdk,
  bbProjectId: string,
): Promise<string | null> {
  const project = (await sdk.projects.get({ projectId: bbProjectId })) as {
    sources?: { hostId: string; isDefault: boolean }[];
  };
  const sources = project.sources ?? [];
  return (
    (sources.find((source) => source.isDefault) ?? sources[0])?.hostId ?? null
  );
}

export interface CatalogCheck {
  ok: boolean;
  reason: string | null;
  supportsFork: boolean | null;
}

const catalogCache = new Map<
  string,
  { at: number; value: Awaited<ReturnType<Sdk["providers"]["models"]>> }
>();
const CATALOG_TTL_MS = 5 * 60_000;

/**
 * Check a profile against the target machine's live catalog. An unavailable
 * model or effort is reported; there is never a silent fallback.
 */
export async function checkCatalog(
  sdk: Sdk,
  profile: Profile,
  routing: { hostId: string | null } | { environmentId: string },
  now = Date.now(),
): Promise<CatalogCheck> {
  const key = `${"environmentId" in routing ? `env:${routing.environmentId}` : `host:${routing.hostId ?? "default"}`}:${profile.providerId}`;
  let catalog = catalogCache.get(key);
  if (!catalog || now - catalog.at > CATALOG_TTL_MS) {
    const args =
      "environmentId" in routing
        ? {
            environmentId: routing.environmentId,
            providerId: profile.providerId,
          }
        : routing.hostId
          ? { hostId: routing.hostId, providerId: profile.providerId }
          : { providerId: profile.providerId };
    catalog = { at: now, value: await sdk.providers.models(args) };
    catalogCache.set(key, catalog);
  }
  const value = catalog.value;
  const provider = value.providers.find(
    (entry) => entry.id === profile.providerId,
  );
  const supportsFork = provider ? provider.capabilities.supportsFork : null;
  if (
    value.modelLoadError &&
    value.modelLoadError.providerId === profile.providerId
  ) {
    catalogCache.delete(key);
    return {
      ok: false,
      reason: `${profile.providerId}'s model catalog is unavailable (${value.modelLoadError.code}).`,
      supportsFork,
    };
  }
  if (provider && !provider.available)
    return {
      ok: false,
      reason: `${profile.providerId} is not available on that machine.`,
      supportsFork,
    };
  if (
    profile.serviceTier === "fast" &&
    (!provider?.capabilities.supportsServiceTier ||
      (provider.serviceTiers &&
        !provider.serviceTiers.some((tier) => tier.id === "fast")))
  )
    return {
      ok: false,
      reason: `${profile.providerId} does not advertise the fast service tier on that machine. No fallback tier is used.`,
      supportsFork,
    };
  const model = value.models.find(
    (entry) => entry.id === profile.model || entry.model === profile.model,
  );
  if (!model)
    return {
      ok: false,
      reason: `${profile.model} is not in ${profile.providerId}'s catalog on that machine. No fallback model is used.`,
      supportsFork,
    };
  const efforts = model.supportedReasoningEfforts.map(
    (entry) => entry.reasoningEffort as ReasoningLevel,
  );
  if (efforts.length && !efforts.includes(profile.reasoningLevel))
    return {
      ok: false,
      reason: `${profile.model} does not support ${profile.reasoningLevel} effort (supports ${efforts.join(", ")}).`,
      supportsFork,
    };
  return { ok: true, reason: null, supportsFork };
}

export function clearCatalogCache() {
  catalogCache.clear();
}

/** The execution BB last resolved for a thread, or null when unknown. */
export async function threadExecution(sdk: Sdk, threadId: string) {
  try {
    const options = await sdk.threads.defaultExecutionOptions({ threadId });
    return options
      ? {
          model: options.model,
          reasoningLevel: options.reasoningLevel as ReasoningLevel,
          ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

export function promptTexts(history: unknown): string[] {
  if (!Array.isArray(history)) return [];
  const texts: string[] = [];
  for (const entry of history) {
    const input = (entry as { input?: unknown }).input;
    if (!Array.isArray(input)) continue;
    for (const block of input) {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") texts.push(text);
    }
  }
  return texts;
}
