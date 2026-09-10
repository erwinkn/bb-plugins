import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { PromptRole } from "./prompt-store";
import { Button } from "./components/ui/button";

export function PromptEditor({ role = "aide" }: { role?: PromptRole }) {
  const rpc = useRpc<typeof rpcContract>();
  const [active, setActive] = useState<string | null>(null);
  const [defaults, setDefaults] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [versions, setVersions] = useState<{id:number;ts:number;source:string;note:string|null;content:string}[]>([]);
  const [versionId, setVersionId] = useState("");
  const current = useRef({ active: null as string | null, draft: "" });
  const generation = useRef(0);
  const label = role === "aide" ? "Live prompt" : role === "worker" ? "Worker prompt" : role === "live" ? "Previous live prompt" : "Coordinator prompt";
  const limit = role === "coordinator" ? 4096 : 32000;
  const readOnly = role === "coordinator" || role === "live";
  const refresh = useCallback(() => {
    const request = ++generation.current;
    void rpc.call("getPrompt", { role }).then(
      (result) => {
        if (request !== generation.current) return;
        if (
          current.current.active === null ||
          current.current.draft === current.current.active
        ) {
          current.current.draft = result.content;
          setDraft(result.content);
        }
        current.current.active = result.content;
        setActive(result.content);
        setDefaults(result.defaultContent);
        setVersions(result.versions);
        setError(null);
      },
      (cause) => {
        if (request === generation.current) setError(String(cause));
      },
    );
  }, [rpc, role]);
  useEffect(() => {
    refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  useRealtime("prompt-changed", refresh);
  const edit = (text: string) => {
    current.current.draft = text;
    setDraft(text);
    setSaved(false);
  };
  async function save() {
    setBusy(true);
    generation.current++;
    const content = draft;
    try {
      await rpc.call("setPrompt", {
        role,
        content,
        source: "user",
        note: "edited in settings",
      });
      current.current.active = content;
      setActive(content);
      setSaved(true);
      setError(null);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const version = versions.find(item => String(item.id) === versionId);
  const history = <div className="min-w-0 space-y-2">
    {versions.length ? <label className="block min-w-0 space-y-1 text-sm">Saved version
      <select aria-label={`${label} version`} className="block w-full min-w-0 max-w-full rounded-md border border-border bg-background p-2 text-sm" value={versionId} onChange={event => setVersionId(event.target.value)}>
        <option value="">Current version</option>
        {versions.map(item => <option key={item.id} value={item.id}>{new Date(item.ts).toLocaleString()} · {item.source}{item.note ? ` · ${item.note}` : ""}</option>)}
      </select>
    </label> : <p className="text-xs text-muted-foreground">No saved versions.</p>}
    <pre aria-label={`${label} history`} className="max-h-96 min-w-0 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">{version?.content ?? active ?? "Loading..."}</pre>
    {version && !readOnly ? <Button size="sm" variant="outline" disabled={busy} onClick={() => edit(version.content)}>Use this version</Button> : null}
  </div>;
  if (readOnly) return <section aria-label={`${label} history section`} className="min-w-0 space-y-3">
    <h4 className="text-sm font-medium">{label}</h4>
    <p className="text-sm text-muted-foreground">Previous prompts are kept as read-only history.</p>
    {history}
    {error ? <p role="alert" className="break-words text-sm text-destructive">{error}</p> : null}
  </section>;
  return (
    <section className="space-y-3 min-w-0">
      <label className="block space-y-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">
          This complete role prompt is sent exactly as shown. Tool descriptions,
          playback instructions, and session context are supplied separately.{" "}
          {role === "aide"
            ? "Changes apply to the next call."
            : "Changes apply to newly launched workers. Profile and task instructions follow this base prompt."}
        </span>
        <textarea
          aria-label={label}
          value={draft}
          rows={18}
          disabled={active === null || busy}
          onChange={(event) => edit(event.target.value)}
          className="block w-full min-w-0 resize-y rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed text-foreground"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={
            busy ||
            active === null ||
            draft === active ||
            !draft.trim() ||
            draft.length > limit
          }
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || active === null || draft === active}
          onClick={() => edit(active!)}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || active === null || draft === defaults}
          onClick={() => edit(defaults)}
        >
          Restore default
        </Button>
        <span
          className={`text-xs ${draft.length > limit ? "text-destructive" : "text-muted-foreground"}`}
        >
          {draft.length.toLocaleString()} / {limit.toLocaleString()} characters
        </span>
        {saved ? (
          <span role="status" className="text-xs text-muted-foreground">
            Saved
          </span>
        ) : null}
      </div>
      <details className="min-w-0 space-y-3"><summary className="cursor-pointer text-sm font-medium">Version history</summary>{history}</details>
      {error ? (
        <div role="alert" className="text-sm text-destructive">
          {error} <button onClick={refresh}>Retry loading</button>
        </div>
      ) : null}
    </section>
  );
}
