import { z } from "zod";
import { ProjectError, projectHostId, type Sdk } from "./bb";
import { environmentSchema, type EnvironmentChoice, type PlacementRecord } from "./schema";
import { ToolInputError } from "./tool-errors";

/**
 * W499: where a new native thread runs, as the tools take it: a host and, on it, the project's
 * checkout or a new BB-managed worktree. The older `environment` argument mixed the two up and
 * could not name a host; it stays as a deprecated alias until about 2026-10-24.
 */
export const placementFields = {
  host: z.string().trim().min(1).max(120).optional().describe("The host to run on, by name or id; default: the project's default host. An unknown, ambiguous or disconnected host fails; there is no fallback."),
  worktree: z.boolean().optional().describe("true: a new BB-managed worktree on that host. Default false: the project's checkout there, which fails if the project has none on that host."),
  environment: environmentSchema.optional().describe("Deprecated: use host and worktree."),
};

/**
 * Where a thread runs. `host` is a host name or id as asked (null: the project's default host).
 * Reuse pins a known environment: reviews, coordinator handovers and the deprecated alias.
 * Recorded is what a worker's spawn recorded, used as it is when its environment is unknown.
 */
export type Placement =
  | { type: "project-default" }
  | { type: "reuse"; environmentId: string }
  | { type: "host"; host: string | null; worktree: boolean }
  | { type: "recorded"; record: PlacementRecord };

/** A placement a caller can ask for; only the plugin reads a worker's record. */
export type AskedPlacement = Exclude<Placement, { type: "recorded" }>;

export const BOTH_PLACEMENTS = "Give host and worktree, or the deprecated environment, not both.";

/** The placement a call asked for, or undefined when it named none (today's default applies). */
export function placementOf(args: { host?: string; worktree?: boolean; environment?: EnvironmentChoice }): AskedPlacement | undefined {
  const named = args.host !== undefined || args.worktree !== undefined;
  if (named && args.environment) throw new ToolInputError(BOTH_PLACEMENTS);
  if (args.environment)
    return args.environment.type === "worktree" ? { type: "host", host: null, worktree: true } : args.environment;
  return named ? { type: "host", host: args.host ?? null, worktree: args.worktree ?? false } : undefined;
}

type Host = Awaited<ReturnType<Sdk["hosts"]["list"]>>[number];

/**
 * The connected host a name or id names. Unknown, ambiguous and disconnected hosts are refused,
 * never replaced by another one. Destroyed hosts don't count.
 */
export async function resolveHost(sdk: Sdk, asked: string): Promise<Host> {
  const hosts = (await sdk.hosts.list()).filter((host) => host.lifecycle?.phase !== "destroyed");
  const known = () => hosts.map((host) => `${host.name} (${host.id})`).join(", ") || "none";
  const byId = hosts.find((host) => host.id === asked);
  const exact = hosts.filter((host) => host.name === asked);
  const matches = byId ? [byId] : exact.length ? exact : hosts.filter((host) => host.name.toLowerCase() === asked.toLowerCase());
  if (!matches.length) throw new ProjectError(`No host is named "${asked}". Hosts: ${known()}.`);
  if (matches.length > 1)
    throw new ProjectError(`"${asked}" names ${matches.length} hosts: ${matches.map((host) => host.id).join(", ")}. Give its id.`);
  const host = matches[0]!;
  if (host.status !== "connected")
    throw new ProjectError(`Host ${host.name} (${host.id}) is ${host.status}. Nothing was started; start it on a connected host.`);
  return host;
}

export type Workspace = "shared" | "isolated";

/** A placement made concrete for one BB project: the spawn request and what to record of it. */
export interface ResolvedPlacement {
  request: Parameters<Sdk["threads"]["spawn"]>[0]["environment"];
  workspace: Workspace;
  /** Known before the spawn only for a reuse. */
  environmentId: string | null;
  /** The machine whose catalog decides availability; null for a reuse, which routes by environment. */
  hostId: string | null;
  record: PlacementRecord | null;
}

/**
 * The spawn request for a placement in `bbProjectId`. A checkout is the project's registered
 * source on that host (its default one when it has several there); a project without one there
 * is refused. A worktree is BB's to create: its errors reach the caller as they are.
 */
export async function resolvePlacement(sdk: Sdk, bbProjectId: string, placement: Placement): Promise<ResolvedPlacement> {
  if (placement.type === "reuse")
    return { request: placement, workspace: "shared", environmentId: placement.environmentId, hostId: null, record: null };
  if (placement.type === "project-default")
    return { request: placement, workspace: "shared", environmentId: null, hostId: await projectHostId(sdk, bbProjectId), record: null };
  // The exact host and path recorded, never re-derived from the project's sources. A recorded
  // worktree whose environment is unknown only routes more work to its host: a review refuses it
  // first, and it is not a new worktree, so it stays "shared" for overlap warnings.
  if (placement.type === "recorded") {
    const { record } = placement;
    return "path" in record
      ? { request: { type: "host", hostId: record.hostId, workspace: { type: "unmanaged", path: record.path } }, workspace: "shared", environmentId: null, hostId: record.hostId, record }
      : { request: worktreeRequest(record.hostId), workspace: "shared", environmentId: null, hostId: record.hostId, record };
  }
  const host = placement.host === null ? null : await resolveHost(sdk, placement.host);
  const hostId = host?.id ?? (await projectHostId(sdk, bbProjectId));
  if (placement.worktree)
    return {
      request: worktreeRequest(hostId),
      workspace: "isolated",
      environmentId: null,
      hostId,
      record: hostId ? { hostId, worktree: true } : null,
    };
  const project = (await sdk.projects.get({ projectId: bbProjectId })) as { sources?: { hostId: string; isDefault: boolean; path?: string }[] };
  const where = host ? `host ${host.name} (${host.id})` : `its default host${hostId ? ` (${hostId})` : ""}`;
  const sources = (project.sources ?? []).filter((source) => hostId && source.hostId === hostId && source.path);
  const source = sources.length > 1 ? sources.find((entry) => entry.isDefault) : sources[0];
  if (!source)
    throw new ProjectError(sources.length
      ? `${bbProjectId} has ${sources.length} checkouts on ${where} and none is its default: ${sources.map((entry) => entry.path).join(", ")}.`
      : `${bbProjectId} has no checkout on ${where}. Nothing was started.`);
  return {
    request: { type: "host", hostId: source.hostId, workspace: { type: "unmanaged", path: source.path! } },
    workspace: "shared",
    environmentId: null,
    hostId: source.hostId,
    record: { hostId: source.hostId, path: source.path! },
  };
}

const worktreeRequest = (hostId: string | null): ResolvedPlacement["request"] =>
  ({ type: "host", ...(hostId ? { hostId } : {}), workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } });

/** What BB's environment DTO says of where an environment is; absent fields prove nothing. */
export type EnvironmentFacts = { isWorktree?: boolean | null; hostId?: string | null; path?: string | null };

/**
 * Whether a new thread may share a live writer's checkout, for overlap warnings. Two known
 * environments decide alone. Otherwise a writer known to be in a worktree is elsewhere (the new
 * thread's environment isn't known yet, so it can't be that worktree). A new thread on a named
 * checkout (W499) also rules out a writer whose spawn recorded a worktree, or whose recorded or
 * known checkout is at another host or path. Anything unproven may share it: the warning errs on
 * the side of showing.
 */
export function mayShareCheckout(
  target: { environmentId: string | null; record: PlacementRecord | null },
  writer: { environmentId: string | null; environment: EnvironmentFacts | null; spawned: PlacementRecord | null },
): boolean {
  if (target.environmentId && writer.environmentId) return target.environmentId === writer.environmentId;
  if (target.environmentId) return true;
  if (writer.environment?.isWorktree === true) return false;
  const checkout = target.record && "path" in target.record ? target.record : null;
  if (!checkout) return true;
  const elsewhere = (where: { hostId?: string | null; path?: string | null } | null) =>
    !!where?.hostId && !!where.path && (where.hostId !== checkout.hostId || where.path !== checkout.path);
  if (writer.spawned && "worktree" in writer.spawned) return false;
  return !elsewhere(writer.spawned) && !elsewhere(writer.environment);
}
