import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  useRpc,
  useSettings,
  type PluginFileOpenerProps,
  type PluginFileOpenerSource,
  type PluginNewThreadPanelProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { CLAIMED_EXTENSIONS } from "@/lib/languages";
import { prefsFrom, type EditorPrefs } from "@/lib/editor-options";
import { EDITOR_COMMANDS, isCommandAvailable, runEditorCommand } from "@/lib/editor-commands";
import { Workbench, type WorkbenchProps } from "@/components/Workbench";
import { DiffWorkbench } from "@/components/DiffWorkbench";
import { BbDiffRenderer } from "@/components/BbDiffRenderer";
import { GuardedSurface } from "@/components/SurfaceBoundary";

type SetPref = WorkbenchProps["onSetPref"];

/**
 * Effective preferences plus a writer. A toolbar toggle applies at once and
 * persists through the plugin's settings; the settings store then confirms
 * it (or the override is dropped if the write fails).
 */
function usePrefs(): { prefs: EditorPrefs; setPref: SetPref } {
  const rpc = useRpc<typeof rpcContract>();
  const { values } = useSettings();
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const prefs = useMemo(
    () => prefsFrom({ ...(values as Record<string, unknown> | null | undefined), ...overrides }),
    [values, overrides],
  );
  useEffect(() => {
    setOverrides((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([key, value]) => (values as Record<string, unknown>)?.[key] !== value));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [values]);
  // Writes go out one after another, so two quick toggles cannot land in
  // the wrong order and persist the older value.
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const setPref = useCallback<SetPref>(
    (...[key, value]) => {
      setOverrides((current) => ({ ...current, [key]: value }));
      writeQueue.current = writeQueue.current.then(() =>
        rpc
          .call("setSetting", { key, value } as Parameters<typeof rpc.call<"setSetting">>[1])
          .then(() => undefined)
          .catch(() => {
            setOverrides((current) => {
              const { [key]: _dropped, ...rest } = current;
              return rest;
            });
          }),
      );
    },
    [rpc],
  );
  return { prefs, setPref };
}

function workspaceKeyFor(source: PluginFileOpenerSource): string {
  return `${source.kind}:${source.environmentId ?? source.projectId ?? source.threadId ?? "default"}`;
}

/** The `fileOpener`: BB opens matching files here instead of its preview. */
function FileOpener({ path, source, Original }: PluginFileOpenerProps) {
  const { prefs, setPref } = usePrefs();
  return (
    <Workbench
      key={workspaceKeyFor(source)}
      surface="opener"
      source={source}
      initialPath={path}
      workspaceKey={workspaceKeyFor(source)}
      label=""
      prefs={prefs}
      onSetPref={setPref}
      Original={Original}
    />
  );
}

type WorkspaceState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; source: PluginFileOpenerSource; root: string; label: string };

function useWorkspace(threadId: string | null, projectId: string | null): WorkspaceState {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<WorkspaceState>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void rpc
      .call("workspace", { threadId, projectId })
      .then((result) => {
        if (!cancelled) setState({ kind: "ready", ...result });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ kind: "error", message: error instanceof Error ? error.message : "Could not resolve the workspace" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, projectId]);
  return state;
}

function pathParam(params: unknown): string | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const path = (params as { path?: unknown }).path;
  return typeof path === "string" && path !== "" ? path : null;
}

function FilesPanelBody({ workspace, initialPath }: { workspace: WorkspaceState; initialPath: string | null }) {
  const { prefs, setPref } = usePrefs();
  if (workspace.kind === "loading") {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading workspace…</div>;
  }
  if (workspace.kind === "error") {
    return <p className="p-4 text-sm text-destructive">{workspace.message}</p>;
  }
  return (
    <Workbench
      key={workspaceKeyFor(workspace.source)}
      surface="panel"
      source={workspace.source}
      initialPath={initialPath}
      workspaceKey={workspaceKeyFor(workspace.source)}
      label={workspace.label}
      prefs={prefs}
      onSetPref={setPref}
    />
  );
}

/** The "Files" tab in a thread's side panel. */
function ThreadFilesPanel({ threadId, params }: PluginThreadPanelProps) {
  const workspace = useWorkspace(threadId, null);
  return <FilesPanelBody workspace={workspace} initialPath={pathParam(params)} />;
}

function ThreadChangesPanel({ threadId, params }: PluginThreadPanelProps) {
  const { prefs, setPref } = usePrefs();
  return <DiffWorkbench threadId={threadId} params={params} prefs={prefs} onSetPref={setPref} />;
}

/** The "Files" tab on the New thread screen: the project's default checkout. */
function NewThreadFilesPanel({ projectId, params }: PluginNewThreadPanelProps) {
  const workspace = useWorkspace(null, projectId);
  if (projectId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Select a project to browse its files.</p>;
  }
  return <FilesPanelBody workspace={workspace} initialPath={pathParam(params)} />;
}

// Every slot body sits behind a surface boundary: a crash stays inside the
// plugin, reported and retryable, instead of BB disabling the slot for the
// session. The wrappers are named so the slot registry keeps stable components.
function GuardedFileOpener(props: PluginFileOpenerProps) {
  return (
    <GuardedSurface phase="file-opener" path={props.path}>
      <FileOpener {...props} />
    </GuardedSurface>
  );
}

function GuardedThreadFilesPanel(props: PluginThreadPanelProps) {
  return (
    <GuardedSurface phase="files-panel" path={pathParam(props.params)}>
      <ThreadFilesPanel {...props} />
    </GuardedSurface>
  );
}

function GuardedThreadChangesPanel(props: PluginThreadPanelProps) {
  return (
    <GuardedSurface phase="changes-panel" path={pathParam(props.params)}>
      <ThreadChangesPanel {...props} />
    </GuardedSurface>
  );
}

function GuardedNewThreadFilesPanel(props: PluginNewThreadPanelProps) {
  return (
    <GuardedSurface phase="files-panel" path={pathParam(props.params)}>
      <NewThreadFilesPanel {...props} />
    </GuardedSurface>
  );
}

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "editor",
    title: "Editor",
    extensions: CLAIMED_EXTENSIONS,
    component: GuardedFileOpener,
  });

  app.slots.threadPanelAction({
    id: "files",
    title: "Files",
    icon: "Folder",
    layout: "flush",
    component: GuardedThreadFilesPanel,
  });

  app.slots.threadPanelAction({
    id: "changes",
    title: "Changes",
    icon: "FileDiff",
    layout: "flush",
    component: GuardedThreadChangesPanel,
  });

  // Exclusive: BB's timeline diffs, its diff panel's bodies and other plugins'
  // `experimental_Diff` calls all render here while this plugin is enabled.
  app.slots.experimental_diffRenderer({
    id: "pierre-diffs",
    title: "Pierre diffs",
    description: "Draws BB's diffs with the same viewer as the Changes tab.",
    component: BbDiffRenderer,
  });

  app.slots.commandPaletteAction({
    id: "open-changes",
    title: "Editor: open changes",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ openPanel }) => { openPanel({ actionId: "changes" }); },
  });

  app.slots.experimental_newThreadPanelAction({
    id: "files",
    title: "Files",
    icon: "Folder",
    layout: "flush",
    component: GuardedNewThreadFilesPanel,
  });

  for (const command of EDITOR_COMMANDS) {
    app.slots.commandPaletteAction({
      id: command.id,
      title: command.title,
      isAvailable: () => isCommandAvailable(command),
      run: () => runEditorCommand(command),
    });
  }
});
