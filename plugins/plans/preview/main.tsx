/**
 * PREVIEW ONLY: a small shell that mounts the plugin's real surfaces (Plans
 * thread panel tab and thread header button) with BB-like chrome so the
 * layout can be checked on desktop and phone sizes before installing in BB.
 */
import { StrictMode, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster, toast } from "sonner";
import type { BbNavigate } from "@get-bb/plugin-sdk/app";
import {
  PreviewShellProvider,
  useCapturedRegistrations,
  type PreviewShellState,
} from "./sdk-app-shim";
import "./preview.css";
import "../app";

const THREAD_ID = "preview-thread-1";
const PROJECT_ID = "preview-project";

type Viewport = "desktop" | "phone";

interface ThreadPanelState {
  actionId: string;
  title: string;
  params: unknown;
}

function App() {
  const registrations = useCapturedRegistrations();
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [threadPanel, setThreadPanel] = useState<ThreadPanelState | null>(null);
  const [showPanel, setShowPanel] = useState(true);

  // Portalled overlays mount on body, so the theme class must live on <html>.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const navigate = useMemo<BbNavigate>(
    () => ({
      toThread: (id) => toast(`Navigate to thread ${id}`),
      toProject: (id) => toast(`Navigate to project ${id}`),
      toPluginPanel: () => {},
      toCompose: () => toast("Navigate to compose"),
      openThreadPanel: ({ actionId, title, params }) => {
        setThreadPanel({ actionId, title: title ?? "Plan", params: params ?? null });
        setShowPanel(true);
        return true;
      },
      openUrl: (url) => {
        window.open(url, "_blank", "noopener");
        return true;
      },
      experimental_openFilePreview: () => false,
      experimental_openFileExternally: () => false,
    }),
    [],
  );

  const shell: PreviewShellState = useMemo(
    () => ({
      context: { projectId: PROJECT_ID, threadId: THREAD_ID },
      navigate,
    }),
    [navigate],
  );

  const panelAction = registrations.threadPanelActions[0];
  const headerAction = registrations.threadHeaderActions[0];
  const isPhone = viewport === "phone";

  const body =
    panelAction ? (
      <div className="flex h-full min-h-0 flex-col">
        <Chrome title="Plan review preview">
          {headerAction ? (
            <headerAction.component threadId={THREAD_ID} projectId={PROJECT_ID} isCompactViewport={isPhone} />
          ) : null}
          <ChromeButton
            onClick={() => {
              void panelAction.run?.({
                threadId: THREAD_ID,
                openPanel: (options) => {
                  setThreadPanel({ actionId: panelAction.id, title: options?.title ?? panelAction.title, params: options?.params ?? null });
                  setShowPanel(true);
                  return true;
                },
              });
            }}
          >
            {panelAction.title}
          </ChromeButton>
          {threadPanel ? (
            <ChromeButton onClick={() => setShowPanel((open) => !open)}>{showPanel ? "Hide panel" : "Show panel"}</ChromeButton>
          ) : null}
        </Chrome>
        <div className="flex min-h-0 flex-1">
          {!isPhone || !showPanel || threadPanel === null ? (
            <div className="flex min-w-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
              Thread timeline (host-rendered in BB). Use “{panelAction.title}” above.
            </div>
          ) : null}
          {threadPanel !== null && showPanel ? (
            <div className={isPhone ? "flex min-w-0 flex-1 flex-col" : "flex w-[420px] shrink-0 flex-col border-l border-border"}>
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
                <span className="rounded-md bg-state-active px-2 py-0.5">{threadPanel.title}</span>
                <button type="button" className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => setShowPanel(false)}>
                  Close
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <panelAction.component threadId={THREAD_ID} params={threadPanel.params as never} />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    ) : (
      <p className="p-6 text-sm text-muted-foreground">No registrations captured.</p>
    );

  return (
    <PreviewShellProvider value={shell}>
      <div className="flex h-full flex-col bg-neutral-200 text-foreground dark:bg-neutral-900">
        <div className="flex flex-wrap items-center gap-2 border-b border-neutral-300 bg-neutral-100 px-3 py-2 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
          <strong className="mr-2">Plans preview</strong>
          <Segmented value={viewport} onChange={setViewport} options={[["desktop", "Desktop"], ["phone", "Phone"]]} />
          <label className="ml-auto flex items-center gap-1.5">
            <input type="checkbox" checked={dark} onChange={(event) => setDark(event.target.checked)} />
            Dark
          </label>
          <a className="underline" href="/preview/messages" target="_blank" rel="noreferrer">
            Sent messages
          </a>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <div
            data-bb-plugin-root=""
            className={
              isPhone
                ? "h-[844px] max-h-full w-[390px] overflow-hidden rounded-[2rem] border-8 border-neutral-800 bg-background shadow-2xl"
                : "h-full w-full overflow-hidden rounded-lg border border-neutral-300 bg-background shadow-lg dark:border-neutral-700"
            }
          >
            {body}
          </div>
        </div>
        <Toaster position="bottom-right" theme={dark ? "dark" : "light"} />
      </div>
    </PreviewShellProvider>
  );
}

function Chrome({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-4">
      <span className="text-sm font-medium">{title}</span>
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

function ChromeButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-7 rounded-md border border-border px-2 text-xs hover:bg-state-hover"
    >
      {children}
    </button>
  );
}

function Segmented<Value extends string>({
  value,
  onChange,
  options,
}: {
  value: Value;
  onChange: (value: Value) => void;
  options: Array<[Value, string]>;
}) {
  return (
    <span className="inline-flex overflow-hidden rounded-md border border-neutral-300 dark:border-neutral-600">
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={`px-2 py-1 ${key === value ? "bg-neutral-800 text-white dark:bg-neutral-200 dark:text-neutral-900" : "hover:bg-neutral-200 dark:hover:bg-neutral-700"}`}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
