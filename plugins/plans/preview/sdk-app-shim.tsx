/**
 * PREVIEW ONLY. Stands in for `@get-bb/plugin-sdk/app` when the plugin UI runs
 * under Vite outside BB. RPC goes over HTTP to the preview middleware, which
 * runs the real server.ts inside the SDK's fake host; realtime signals are
 * synthesized locally after mutations; navigation updates the preview shell.
 * Nothing here ships in the plugin bundle.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { preloadHighlighter } from "@pierre/diffs";
import { PatchDiff } from "@pierre/diffs/react";
import ReactMarkdown from "react-markdown";
import type {
  BbContext,
  BbNavigate,
  DiffProps,
  ExperimentalIconProps,
  MarkdownProps,
  PluginAppDefinition,
  PluginAppSetup,
  PluginRealtimeConnectionState,
  PluginRpcClient,
  PluginSidebarThreadsState,
  PluginRpcContract,
} from "@get-bb/plugin-sdk/app";

/* ---------- realtime bus ---------- */

type Handler = (payload: unknown) => void;
const channels = new Map<string, Set<Handler>>();

export function emitRealtime(channel: string, payload: unknown): void {
  for (const handler of channels.get(channel) ?? []) handler(payload);
}

const MUTATIONS = new Set([
  "create", "addAnnotation", "updateAnnotation", "withdrawAnnotation", "replyToAnnotation", "resolveAnnotation", "setDeliveryMode", "remove", "approve",
]);

/* ---------- rpc over the preview middleware ---------- */

async function callRpc(method: string, input: unknown): Promise<unknown> {
  const response = await fetch(`/preview/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input ?? {}),
  });
  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `RPC ${method} failed (${response.status})`;
    throw new Error(message);
  }
  if (MUTATIONS.has(method)) {
    emitRealtime("plans-changed", { method });
    if (method === "create" && typeof body === "object" && body !== null) {
      const plan = body as { id?: unknown; threadId?: unknown };
      if (typeof plan.id === "string" && typeof plan.threadId === "string") {
        emitRealtime("plan-submitted", { id: plan.id, threadId: plan.threadId });
      }
    }
  }
  return body;
}

const rpcClient: PluginRpcClient = {
  call: ((method: string, input?: unknown) => callRpc(method, input)) as PluginRpcClient["call"],
};

export function useRpc<Contract extends PluginRpcContract = PluginRpcContract>(): PluginRpcClient<Contract> {
  return rpcClient as unknown as PluginRpcClient<Contract>;
}

export function useRealtime(channel: string, handler: Handler): void {
  useEffect(() => {
    let set = channels.get(channel);
    if (!set) {
      set = new Set();
      channels.set(channel, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }, [channel, handler]);
}

export function useRealtimeConnectionState(): PluginRealtimeConnectionState {
  return "connected";
}

export function useSettings() {
  return { values: {}, isLoading: false };
}

/* ---------- shell state: route + navigation ---------- */

export interface PreviewShellState {
  context: BbContext;
  navigate: BbNavigate;
}

const ShellContext = createContext<PreviewShellState | null>(null);

export function PreviewShellProvider({ value, children }: { value: PreviewShellState; children: ReactNode }) {
  useEffect(() => {
    let cursor = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/preview/events?after=${cursor}`);
        const update = await response.json();
        if (stopped) return;
        cursor = update.cursor;
        for (const signal of update.signals) emitRealtime(signal.channel, signal.payload);
        emitRealtime("preview-status", { working: update.working, pending: update.pending });
      } finally { if (!stopped) timer = setTimeout(() => void poll().catch(() => {}), 400); }
    };
    void poll().catch(() => {});
    return () => { stopped = true; clearTimeout(timer); };
  }, []);
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

function useShell(): PreviewShellState {
  const shell = useContext(ShellContext);
  if (shell === null) throw new Error("Preview shell missing");
  return shell;
}

export function useBbContext(): BbContext {
  return useShell().context;
}

export function useBbNavigate(): BbNavigate {
  return useShell().navigate;
}

/* ---------- host components ---------- */

export function Markdown({ content, className }: MarkdownProps) {
  return (
    <div className={["preview-markdown", className].filter(Boolean).join(" ")}>
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}

/** Pierre preview renderer; production delegates to BB's native Pierre view. */
export function experimental_Diff({ patch, path, view = "unified", overflow = "wrap", showLineNumbers = true, className }: DiffProps) {
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    preloadHighlighter({ themes: ["github-dark", "github-light"], langs: ["markdown"] })
      .then(() => { if (active) setReady(true); })
      .catch((error) => { if (active) setFailure(String(error)); });
    return () => { active = false; };
  }, []);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  const completePatch = useMemo(() => patch.startsWith("@@")
    ? `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${patch}`
    : patch, [patch, path]);
  if (failure) return <p role="alert">{failure}</p>;
  if (!ready) return <p className="p-3 text-sm text-muted-foreground">Loading changes…</p>;
  return <PatchDiff
    patch={completePatch}
    className={className}
    options={{
      diffStyle: view,
      overflow,
      disableFileHeader: true,
      disableLineNumbers: !showLineNumbers,
      hunkSeparators: "simple",
      theme: { dark: "github-dark", light: "github-light" },
      themeType: dark ? "dark" : "light",
      unsafeCSS: ":host { --diffs-bg: var(--background); --diffs-bg-buffer-override: var(--background); background: var(--background); }",
    }}
  />;
}

export function experimental_SourceCode({ content }: { content: string }) {
  return <pre className="m-0 p-3 font-mono text-xs">{content}</pre>;
}

export function UrlLink(props: React.ComponentProps<"a">) {
  return <a {...props} />;
}

/** Placeholder glyph; the real host draws its registry icon for `name`. */
export function experimental_Icon({ name, className, style, "aria-hidden": ariaHidden, "aria-label": ariaLabel }: ExperimentalIconProps) {
  const Registered = registeredIcons.get(name);
  if (Registered) return <Registered className={className} />;
  return (
    <svg className={className} style={style} viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden={ariaHidden} aria-label={ariaLabel} data-icon={name}>
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}
const registeredIcons = new Map<string, ComponentType<{ className?: string }>>();

/* ---------- registration capture ---------- */

export interface CapturedRegistrations {
  navPanels: Array<{ id: string; title: string; path: string; component: ComponentType<{ subPath: string }>; headerContent?: ComponentType<{ subPath: string }>; experimental_sidebarAccessory?: ComponentType }>;
  threadPanelActions: Array<{ id: string; title: string; component: ComponentType<{ threadId: string; params: unknown }>; run?: (context: { threadId: string; openPanel: (options?: { title?: string; params?: unknown }) => boolean }) => void | Promise<void> }>;
  threadHeaderActions: Array<{ id: string; component: ComponentType<{ threadId: string; projectId: string; isCompactViewport: boolean }> }>;
}

const captured: CapturedRegistrations = { navPanels: [], threadPanelActions: [], threadHeaderActions: [] };
const listeners = new Set<() => void>();

export function definePluginApp(setup: PluginAppSetup): PluginAppDefinition {
  const app = {
    slots: new Proxy(
      {},
      {
        get: (_target, slot: string) => (registration: never) => {
          if (slot === "navPanel") captured.navPanels.push(registration);
          else if (slot === "threadPanelAction") captured.threadPanelActions.push(registration);
          else if (slot === "experimental_threadHeaderAction") captured.threadHeaderActions.push(registration);
        },
      },
    ),
    composer: { customize: () => {} },
    contentScripts: { register: () => {} },
    experimental_icons: { register: ({ name, component }: { name: string; component: ComponentType<{ className?: string }> }) => { registeredIcons.set(name, component); } },
    experimental_sidebarFooter: { register: () => undefined },
  };
  setup(app as never);
  for (const listener of listeners) listener();
  return { __bbPluginApp: true, setup };
}

export function useCapturedRegistrations(): CapturedRegistrations {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => captured,
  );
}

export function experimental_useSidebarThreads(): PluginSidebarThreadsState {
  const [status, setStatus] = useState({ working: false, pending: false });
  useRealtime("preview-status", (value) => setStatus(value as typeof status));
  return { status: "ready", projects: [], threads: [{
    id: "preview-thread-1", hasPendingInteraction: status.pending,
    indicator: status.working ? "runtime" : status.pending ? "waiting-for-input" : "none",
  } as PluginSidebarThreadsState["threads"][number]] };
}
