// Types, hooks, and small presentational pieces shared by the nav panel and
// the pull request viewer. Inherited from BB's official GitHub plugin.
import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRealtime, useRpc, type PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { githubRpcContract } from "../contract";
import type { Item } from "../app-logic";
import { Badge } from "./ui/badge";
import { DelayedLoading } from "./ui/delayed-loading";
import { Skeleton } from "./ui/skeleton";

export type Contract = typeof githubRpcContract;
export type { MergeMethod } from "../contract";
export type IssueDetail = PluginRpcResult<Contract["getIssue"]>["issue"];
export type PullDetail = PluginRpcResult<Contract["getPull"]>["pull"];
export type PullCheck = PullDetail["checks"][number];
export type ReviewThread = PullDetail["reviewThreads"][number];
export type PullFile = PullDetail["files"][number];
export type Status = PluginRpcResult<Contract["status"]>;
export type RepoInfo = Status["repos"][number];
export type LinksMap = PluginRpcResult<Contract["listLinks"]>["links"];
export type ThreadLink = LinksMap[string][number];

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function useItems(kind: "issue" | "pr"): { items: Item[] | null; error: string | null } {
  const rpc = useRpc<Contract>();
  const [state, setState] = useState<{ items: Item[] | null; error: string | null }>({ items: null, error: null });
  const refetch = useCallback(() => {
    rpc.call("listItems", { kind }).then(
      (result) => setState({ items: result.items, error: null }),
      (error: unknown) => setState({ items: null, error: errorText(error) }),
    );
  }, [rpc, kind]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("data-changed", refetch);
  return state;
}

export function useLinks(): LinksMap {
  const rpc = useRpc<Contract>();
  const [links, setLinks] = useState<LinksMap>({});
  const refetch = useCallback(() => {
    rpc.call("listLinks").then(
      (result) => setLinks(result.links),
      () => {},
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("links-changed", refetch);
  return links;
}

export function useSpawn(): {
  spawn: (method: "startWork" | "startReview", repo: string, number: number) => void;
  spawningKey: string | null;
} {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const [spawningKey, setSpawningKey] = useState<string | null>(null);
  const spawn = useCallback(
    (method: "startWork" | "startReview", repo: string, number: number) => {
      setSpawningKey(`${repo}#${number}`);
      rpc
        .call(method, { repo, number })
        .then((result) => {
          navigate.toThread(result.threadId);
        })
        .catch((error: unknown) => toast.error(errorText(error)))
        .finally(() => setSpawningKey(null));
    },
    [rpc, navigate],
  );
  return { spawn, spawningKey };
}

let viewerLogin: string | null = null;

export function useViewer(): string | null {
  const rpc = useRpc<Contract>();
  const [login, setLogin] = useState<string | null>(viewerLogin);
  useEffect(() => {
    if (viewerLogin !== null) return;
    rpc.call("viewer").then(
      (result) => {
        viewerLogin = result.login;
        setLogin(result.login);
      },
      () => {},
    );
  }, [rpc]);
  return login;
}

export function useStatus(): { status: Status | null; refetch: () => void } {
  const rpc = useRpc<Contract>();
  const [status, setStatus] = useState<Status | null>(null);
  const refetch = useCallback(() => {
    rpc.call("status").then(
      (result) => setStatus(result),
      () => {},
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("data-changed", refetch);
  return { status, refetch };
}

export function Avatar({ login, size = "size-5", className }: { login: string; size?: string; className?: string }) {
  return (
    <img
      src={`https://github.com/${encodeURIComponent(login)}.png?size=64`}
      alt={login}
      title={login}
      loading="lazy"
      className={`${size} shrink-0 rounded-full bg-muted ${className ?? ""}`}
    />
  );
}

export function ChevronDownIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-50">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M21 12a9 9 0 0 0-15.2-6.5L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 15.2 6.5L21 16" />
      <path d="M16 16h5v5" />
    </svg>
  );
}

function stateDotClass(kind: "issue" | "pr", state: string): string {
  if (state === "OPEN") return "bg-green-500";
  if (kind === "pr" && state === "MERGED") return "bg-purple-500";
  if (kind === "pr") return "bg-red-500";
  return "bg-purple-500";
}

export function StateDot({ kind, state }: { kind: "issue" | "pr"; state: string }) {
  return <span className={`size-2 shrink-0 rounded-full ${stateDotClass(kind, state)}`} />;
}

export function StateBadge({ kind, state }: { kind: "issue" | "pr"; state: string }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <StateDot kind={kind} state={state} />
      {state.toLowerCase()}
    </Badge>
  );
}

export function ThreadPills({ links }: { links: ThreadLink[] | undefined }) {
  const navigate = useBbNavigate();
  if (links === undefined || links.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {links.map((link, index) => (
        <Badge
          key={link.threadId}
          title={`Open BB thread ${link.threadId}`}
          onClick={(event) => {
            event.stopPropagation();
            navigate.toThread(link.threadId);
          }}
          variant="secondary"
          className="cursor-pointer whitespace-nowrap hover:bg-accent"
        >
          ⚡ agent{links.length > 1 ? ` ${index + 1}` : ""}
        </Badge>
      ))}
    </span>
  );
}

export function LabelChips({ labels, className }: { labels: string[]; className?: string }) {
  if (labels.length === 0) return null;
  return (
    <span className={`items-center gap-1 ${className ?? "flex shrink-0"}`}>
      {labels.slice(0, 3).map((label) => (
        <Badge key={label} variant="secondary" className="font-normal text-muted-foreground">
          {label}
        </Badge>
      ))}
    </span>
  );
}

export function SidebarHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{children}</h3>;
}

export function DetailSkeleton() {
  return (
    <DelayedLoading>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    </DelayedLoading>
  );
}
