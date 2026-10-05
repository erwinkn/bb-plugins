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
import { WorkspaceBar, type SwitchConfirm } from "@/components/WorkspaceBar";
import { NoticeAction, NoticeRow } from "@/components/EditorPane";
import { targetThreadParam } from "@/lib/panel-target";
import { useInspectionGate, useWorkspace, type WorkspaceState } from "@/lib/use-workspace";
import { useGuardedSwitch, usePanelTarget, useWorkspaces } from "@/lib/use-panel-target";

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

function pathParam(params: unknown): string | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const path = (params as { path?: unknown }).path;
  return typeof path === "string" && path !== "" ? path : null;
}

function FilesPanelBody({ workspace, initialPath, prefs, onSetPref, inspectOnly = false, onRetry }: { workspace: WorkspaceState; initialPath: string | null; prefs: EditorPrefs; onSetPref: SetPref; inspectOnly?: boolean; onRetry?: () => void }) {
  if (workspace.kind === "loading") {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading workspace…</div>;
  }
  if (workspace.kind === "error") {
    return (
      <div className="p-4">
        <NoticeRow tone="error">
          {workspace.message}
          {onRetry !== undefined ? <NoticeAction onClick={onRetry}>Retry</NoticeAction> : null}
        </NoticeRow>
      </div>
    );
  }
  return (
    <>
      {workspace.refreshError !== null ? (
        <NoticeRow tone="error">
          {workspace.refreshError}
          {onRetry !== undefined ? <NoticeAction onClick={onRetry}>Retry</NoticeAction> : null}
        </NoticeRow>
      ) : null}
      <Workbench
        key={workspaceKeyFor(workspace.source)}
        surface="panel"
        source={workspace.source}
        initialPath={initialPath}
        workspaceKey={workspaceKeyFor(workspace.source)}
        label={workspace.label}
        inspectOnly={inspectOnly}
        prefs={prefs}
        onSetPref={onSetPref}
      />
    </>
  );
}

/**
 * The switch confirmation: identical for the Files and Changes tabs, so one
 * row serves both.
 */
function SwitchConfirmRow({ confirm }: { confirm: SwitchConfirm }) {
  return (
    <NoticeRow tone="warning">
      Switch to {confirm.label} with unsaved changes in this workspace?
      <NoticeAction onClick={confirm.saveAndSwitch}>Save and switch</NoticeAction>
      <NoticeAction onClick={confirm.keepAndSwitch}>Keep unsaved and switch</NoticeAction>
      <NoticeAction onClick={confirm.cancel}>Cancel</NoticeAction>
    </NoticeRow>
  );
}

/**
 * The workspace picker a Files or Changes tab carries: it selects the thread
 * whose workspace the tab inspects (its own by default), surfaces stale and
 * unavailable targets honestly, resolves that workspace once for the guard
 * and the panel, and holds the inspection-mode opt-in.
 */
function useWorkspacePicker(threadId: string, params: unknown, actionId: "files" | "changes", autoSave: "off" | "onBlur" | "afterDelay") {
  const target = usePanelTarget(threadId, params, actionId);
  const workspaces = useWorkspaces(threadId);
  const workspace = useWorkspace(target.targetThreadId, null);
  // The opt-in binds to the resolved environment and requires it fresh: a
  // stale or failed resolution can only be inspected.
  const gate = useInspectionGate(target.targetThreadId, target.foreign, workspace);
  // One Retry re-runs both halves of the picker's evidence: the workspace
  // list AND the selected workspace's resolution, plus whatever the panel
  // body derives from it.
  const [reloadNonce, setReloadNonce] = useState(0);
  const retry = useCallback(() => {
    workspaces.refresh();
    workspace.refresh();
    setReloadNonce((nonce) => nonce + 1);
  }, [workspaces.refresh, workspace.refresh]);
  const guarded = useGuardedSwitch(workspace.kind === "ready" ? workspace.source : null, autoSave, target.switchTarget);
  const inspecting = gate.inspecting;
  const bar = (
    <>
      <WorkspaceBar
        state={workspaces}
        targetThreadId={target.targetThreadId}
        ownThreadId={threadId}
        inspecting={target.foreign}
        editingEnabled={gate.editingEnabled}
        onPick={(entry) => guarded.requestSwitch({ threadId: entry.threadId, label: entry.label })}
        onSetEditing={gate.setEditingEnabled}
        onRefresh={retry}
      />
      {guarded.confirm !== null ? <SwitchConfirmRow confirm={guarded.confirm} /> : null}
    </>
  );
  return { target, inspecting, bar, workspace, retry, reloadNonce };
}

/** The "Files" tab in a thread's side panel. */
function ThreadFilesPanel({ threadId, params }: PluginThreadPanelProps) {
  const { prefs, setPref } = usePrefs();
  const picker = useWorkspacePicker(threadId, params, "files", prefs.autoSave);
  // The persisted path belongs to the persisted target; while the picker's
  // session target differs, it must not open an absolute path of another
  // workspace inside this one.
  const paramTarget = targetThreadParam(params) ?? threadId;
  const initialPath = picker.target.targetThreadId === paramTarget ? pathParam(params) : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {picker.bar}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <FilesPanelBody workspace={picker.workspace} initialPath={initialPath} prefs={prefs} onSetPref={setPref} inspectOnly={picker.inspecting} onRetry={picker.retry} />
      </div>
    </div>
  );
}

function ThreadChangesPanel({ threadId, params }: PluginThreadPanelProps) {
  const { prefs, setPref } = usePrefs();
  const picker = useWorkspacePicker(threadId, params, "changes", prefs.autoSave);
  // The persisted path and comparison belong to the persisted target; while
  // the picker's session target differs, they must not drive this workspace's
  // view — another workspace's identical relative path is a different file.
  const paramTarget = targetThreadParam(params) ?? threadId;
  const boundParams = paramTarget === picker.target.targetThreadId ? params : { targetThreadId: picker.target.targetThreadId };
  return (
    <div className="flex h-full min-h-0 flex-col">
      {picker.bar}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* The target switch remounts the workbench so no state crosses workspaces. */}
        <DiffWorkbench
          key={picker.target.targetThreadId}
          threadId={picker.target.targetThreadId}
          params={boundParams}
          prefs={prefs}
          onSetPref={setPref}
          inspectOnly={picker.inspecting}
          reloadNonce={picker.reloadNonce}
        />
      </div>
    </div>
  );
}

/** The "Files" tab on the New thread screen: the project's default checkout. */
function NewThreadFilesPanel({ projectId, params }: PluginNewThreadPanelProps) {
  const { prefs, setPref } = usePrefs();
  const workspace = useWorkspace(null, projectId);
  if (projectId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Select a project to browse its files.</p>;
  }
  return <FilesPanelBody workspace={workspace} initialPath={pathParam(params)} prefs={prefs} onSetPref={setPref} />;
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
