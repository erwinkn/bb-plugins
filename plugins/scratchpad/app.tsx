import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc, type PluginThreadHeaderActionProps, type PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/ariakit";
import "@blocknote/ariakit/style.css";
import "./style.css";
import "./editor-theme.css";
import type { rpcContract } from "./contract";
import { CHANNEL, documentSchema, type Note, type NoteDocument, type Scope } from "./model";
import { editorSchema, type NoteBlock } from "./schema";
import { NoteSession, type DraftStorage } from "./session";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu";

const ACTION = "scratchpad";
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function NotebookIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="5" y="3" width="15" height="18" rx="2"/><path d="M9 3v18M3 7h4M3 12h4M3 17h4M12 8h5M12 12h5"/></svg>;
}
function HistoryIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7M12 7v5l3 2"/></svg>;
}
function ExportIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M5 16v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4"/></svg>;
}
function download(name: string, data: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function draftStorage(environmentId: string, threadId: string): DraftStorage {
  const key = `bb:scratchpad:draft:${environmentId}:${threadId}`;
  // Session storage keeps drafts isolated between browser tabs and survives reload.
  return {
    read: () => {
      const value = sessionStorage.getItem(key);
      if (!value) return null;
      const draft = JSON.parse(value);
      if (!Number.isInteger(draft.baseRevision)) throw new Error("Invalid draft revision.");
      return { baseRevision: draft.baseRevision, document: documentSchema.parse(draft.document) };
    },
    write: (draft) => { if (draft) sessionStorage.setItem(key, JSON.stringify(draft)); else sessionStorage.removeItem(key); },
  };
}
function useDarkMode() {
  const read = () => document.documentElement.classList.contains("dark") || document.documentElement.dataset.theme === "dark";
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}
function RichEditor({ document, onChange, readOnly = false }: { document: NoteDocument; onChange?: (document: NoteDocument) => void; readOnly?: boolean }) {
  const dark = useDarkMode();
  const editor = useCreateBlockNote({
    schema: editorSchema, initialContent: document as NoteBlock[],
    placeholders: { default: "Jot down an idea, or type / for more…" },
    domAttributes: { editor: { "aria-label": readOnly ? "Saved scratchpad preview" : "Scratchpad document", role: "textbox", "aria-multiline": "true" } },
  });
  return <BlockNoteView className="scratchpad-editor" editor={editor} theme={dark ? "dark" : "light"} editable={!readOnly}
    onChange={onChange ? () => onChange(editor.document as NoteDocument) : undefined} />;
}
function LoadedPad({ threadId, initial }: { threadId: string; initial: { scope: Scope; note: Note } }) {
  const rpc = useRpc<typeof rpcContract>();
  const scope = initial.scope;
  const target = useMemo(() => ({ threadId, environmentId: scope.environmentId }), [threadId, scope.environmentId]);
  const session = useMemo(() => new NoteSession(initial.note,
    (expectedRevision, document) => rpc.call("save", { ...target, expectedRevision, document }), draftStorage(scope.environmentId, threadId)), [target]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const connection = useRealtimeConnectionState();
  const [history, setHistory] = useState<Omit<Note, "document">[] | null>(null);
  const [preview, setPreview] = useState<Note | null>(null);
  const previewRequest = useRef(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useCallback(() => {
    void rpc.call("get", target).then((note) => session.receive(note), (error) => session.reportRefresh(error));
  }, [rpc, target, session]);
  useRealtime(CHANNEL, (payload) => {
    if ((payload as { environmentId?: string } | null)?.environmentId === target.environmentId) refresh();
  });
  useEffect(() => { refresh(); }, [connection, refresh]);
  useEffect(() => {
    session.schedule();
    const timer = setInterval(refresh, 10_000);
    const focus = () => { refresh(); if (!session.getSnapshot().error) void session.flush(); };
    const unload = (event: BeforeUnloadEvent) => {
      if (session.getSnapshot().dirty) { event.preventDefault(); event.returnValue = ""; }
    };
    const hide = () => { if (document.visibilityState === "hidden") void session.flush(); };
    window.addEventListener("focus", focus); window.addEventListener("beforeunload", unload); document.addEventListener("visibilitychange", hide);
    return () => {
      previewRequest.current++;
      clearInterval(timer); window.removeEventListener("focus", focus); window.removeEventListener("beforeunload", unload); document.removeEventListener("visibilitychange", hide);
      void session.flush(); session.dispose();
    };
  }, [refresh, session]);
  const viewPreview = (note: Note | null) => {
    previewRequest.current++; setPreviewLoading(false); setPreview(note);
  };
  const loadPreview = async (revision: number) => {
    const request = ++previewRequest.current;
    // Hide the previous revision immediately so it cannot be restored while
    // the user's newly selected revision is still loading.
    setPreview(null); setPreviewLoading(true);
    try {
      const note = await rpc.call("version", { ...target, revision });
      if (request === previewRequest.current) setPreview(note);
    } catch (error) { if (request === previewRequest.current) session.report(error); }
    finally { if (request === previewRequest.current) setPreviewLoading(false); }
  };
  const showHistory = async () => {
    if (history) { setHistory(null); viewPreview(null); return; }
    try { setHistory(await rpc.call("history", target)); } catch (error) { session.report(error); }
  };
  const restore = async () => {
    if (!preview || state.dirty || state.saving) return;
    setBusy(true);
    try {
      const result = await rpc.call("restore", { ...target, revision: preview.revision, expectedRevision: state.note.revision });
      session.receive(result.note);
      if (!result.ok) setNotice("The scratchpad changed. Review the latest version before restoring.");
      else { viewPreview(null); setHistory(null); setNotice("Revision restored. The previous version is still in history."); }
    } catch (error) { session.report(error); } finally { setBusy(false); }
  };
  const exportMarkdown = async () => {
    try {
      await session.flush();
      if (session.getSnapshot().dirty) { setNotice("Save or resolve your draft before exporting Markdown. Export JSON includes your current draft."); return; }
      const result = await rpc.call("export", target);
      download("scratchpad.md", result.markdown, "text/markdown");
    } catch (error) { session.report(error); }
  };
  return <div className="scratchpad" data-testid="scratchpad-panel">
    <div className="sp-topbar">
      <div className="sp-context"><strong title={scope.projectName}>{scope.projectName}</strong><span title={scope.path} aria-label={`Worktree: ${scope.branch || scope.environmentName}`}>{scope.branch || scope.environmentName}</span></div>
      <button className="sp-button sp-icon-button" type="button" onClick={showHistory} aria-pressed={!!history} aria-label="History" title="History"><HistoryIcon /></button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button className="sp-button sp-icon-button" type="button" aria-label="Export" title="Export"><ExportIcon /></button>
        </DropdownMenuTrigger>
        <DropdownMenuContent aria-label="Export scratchpad">
          <DropdownMenuItem onSelect={() => download("scratchpad.json", JSON.stringify({ ...state.note, document: state.document }, null, 2), "application/json")}>Export JSON</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { void exportMarkdown(); }}>Export Markdown</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    {state.storageWarning && <div className="sp-banner" role="alert">This browser cannot keep a recovery draft. Keep this panel open until your changes are saved.</div>}
    {(state.error || state.refreshError) && <div className="sp-banner" role="alert">{state.error || state.refreshError}<button className="sp-button" onClick={() => { refresh(); void session.flush(); }}>Retry</button></div>}
    {notice && <div className="sp-banner" role="status">{notice}<button className="sp-button" onClick={() => setNotice(null)}>Dismiss</button></div>}
    {state.conflict && <div className="sp-banner sp-conflict" role="alert">
      <strong>The scratchpad changed while you were editing.</strong><span>Your draft is safe below. Review the latest saved version before choosing which to keep.</span>
      <div className="sp-actions"><button className="sp-button" onClick={() => viewPreview(state.conflict)}>Review latest</button>
        <button className="sp-button" onClick={() => { session.useLatest(); viewPreview(null); }}>Use latest</button>
        <button className="sp-button" onClick={() => { session.keepDraft(); viewPreview(null); }}>Save my draft instead</button></div>
    </div>}
    {history && <div className="sp-history" aria-label="Revision history">
      <div className="sp-history-label">Latest {history.length} revisions</div>
      <div className="sp-history-list">{history.map((item) => <button className="sp-button" key={item.revision} onClick={() => { void loadPreview(item.revision); }}>Revision {item.revision} · {item.author} · {new Date(item.updatedAt).toLocaleString()}</button>)}</div>
    </div>}
    {previewLoading && <div className="sp-banner" role="status">Loading revision…<button className="sp-button" onClick={() => viewPreview(null)}>Cancel</button></div>}
    {preview && <div className="sp-preview">
      <div className="sp-preview-header"><strong>Saved revision {preview.revision}</strong><div className="sp-actions">
        {!state.conflict && <button className="sp-button" disabled={state.dirty || state.saving || busy || preview.revision === state.note.revision} onClick={restore}>Restore this revision</button>}
        <button className="sp-button" onClick={() => viewPreview(null)}>Close preview</button></div></div>
      <div className="sp-preview-body"><RichEditor key={`preview-${preview.revision}`} document={preview.document} readOnly /></div>
    </div>}
    <div className="sp-document" onKeyDown={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void session.flush(); }
    }}><RichEditor key={state.editorEpoch} document={state.document} onChange={(document) => session.change(document)} /></div>
  </div>;
}
function ScratchpadPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [opened, setOpened] = useState<{ threadId: string; scope: Scope; note: Note } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false; setError(null);
    rpc.call("open", { threadId }).then((result) => { if (!disposed) setOpened({ ...result, threadId }); }, (error) => { if (!disposed) setError(errorText(error)); });
    return () => { disposed = true; };
  }, [threadId, rpc, attempt]);
  if (error) return <div className="scratchpad sp-loading" role="alert">{error}<button className="sp-button" onClick={() => setAttempt((n) => n + 1)}>Try again</button></div>;
  if (!opened || opened.threadId !== threadId) return <div className="scratchpad sp-loading" role="status">Opening scratchpad…</div>;
  return <LoadedPad key={`${threadId}:${opened.scope.environmentId}`} threadId={threadId} initial={opened} />;
}
function HeaderAction({ isCompactViewport }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  return <button className="sp-header-action" title="Open scratchpad" aria-label="Open scratchpad" onClick={() => navigate.openThreadPanel({ actionId: ACTION, title: "Scratchpad" })}>
    <NotebookIcon />{!isCompactViewport && <span>Scratchpad</span>}
  </button>;
}
export default definePluginApp((app) => {
  app.slots.threadPanelAction({ id: ACTION, title: "Scratchpad", icon: "FileText", layout: "flush", component: ScratchpadPanel });
  app.slots.experimental_threadHeaderAction({ id: "scratchpad", title: "Scratchpad", component: HeaderAction });
});
