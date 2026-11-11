import { useEffect, useRef, useState, type FormEvent, type MutableRefObject } from "react";
import { QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Markdown, experimental_SourceCode as SourceCode, useRpc } from "@get-bb/plugin-sdk/app";
import type { projectsContract } from "./lib/contract";
import { UPLOAD_MAX_BYTES, humanSize, type DriveChange, type DriveEntry, type DriveFile } from "./lib/drive-types";
import { PLUGIN_ID } from "./lib/identity";
import { adventuresQueryClient, refresh } from "./lib/query";
import { driveFileQuery, driveListQuery, queryKeys, useDriveSync } from "./lib/queries";

/** W584: the Adventure's drive in the Context tab: its files, one open file, and the changes the user makes. */
export function DriveFiles({ projectId }: { projectId: string }) {
  return (
    <QueryClientProvider client={adventuresQueryClient()}>
      <Files projectId={projectId} />
    </QueryClientProvider>
  );
}

type Api = ReturnType<typeof useRpc<typeof projectsContract>>;
type Ask = { kind: "file" | "folder" | "move"; from?: string; value: string };
const PREFETCH_DWELL_MS = 150;
const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const rawUrl = (projectId: string, path: string, extra = "") =>
  `/api/v1/plugins/${PLUGIN_ID}/http/drive/raw?${new URLSearchParams({ projectId, path })}${extra}`;

function Files({ projectId }: { projectId: string }) {
  useDriveSync(projectId);
  const api = useRpc<typeof projectsContract>();
  const client = useQueryClient();
  const list = useQuery(driveListQuery(api, projectId));
  const [open, setOpen] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [ask, setAsk] = useState<Ask | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const dwell = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Whether the open file has an unsaved edit: the user's own actions that would drop it ask first.
  const editing = useRef(false);
  const keepsDraft = (path: string) =>
    !editing.current || !(open === path || open?.startsWith(`${path}/`)) || window.confirm(`Drop your unsaved edit of ${open}?`);
  const entries = list.data?.entries ?? [];
  const exists = (path: string) => entries.some((e) => e.path === path);
  const done = () => refresh(client, queryKeys.drive(projectId));
  const change = useMutation({
    mutationFn: (change: DriveChange) => api.call("driveChange", { projectId, change }),
    onSuccess: done,
    onError: (error) => setProblem(error.message),
  });
  const create = useMutation({
    mutationFn: (path: string) => api.call("driveSave", { projectId, path, text: path.endsWith(".md") ? `# ${path.split("/").pop()!.slice(0, -3)}\n` : "", base: null }),
    onSuccess: (answer, path) => {
      if ("conflict" in answer) return setProblem(`${path} already exists.`);
      client.setQueryData(queryKeys.driveFile(projectId, path), answer.saved);
      setOpen(path);
      done();
    },
    onError: (error) => setProblem(error.message),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ask) return;
    const path = ask.value.trim().replace(/^\/+|\/+$/gu, "");
    setProblem(null);
    if (!path) return;
    if (ask.kind === "file" && open && !keepsDraft(open)) return;
    if (ask.kind === "file") create.mutate(path);
    else if (ask.kind === "folder") change.mutate({ kind: "mkdir", path });
    else if (path !== ask.from && keepsDraft(ask.from!)) {
      change.mutate({ kind: "move", from: ask.from!, to: path }, {
        onSuccess: () => {
          if (open === ask.from) setOpen(path);
          else if (open?.startsWith(`${ask.from}/`)) setOpen(path + open.slice(ask.from!.length));
        },
      });
    }
    setAsk(null);
  };

  const uploadFiles = async (files: FileList | null) => {
    setProblem(null);
    for (const file of Array.from(files ?? [])) {
      const path = join(folder, file.name);
      if (file.size > UPLOAD_MAX_BYTES) {
        setProblem(`${file.name} is ${humanSize(file.size)}: an upload is at most ${humanSize(UPLOAD_MAX_BYTES)}.`);
        continue;
      }
      const replace = exists(path);
      if (replace && !window.confirm(`Replace ${path}?`)) continue;
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/u, ""));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      await change.mutateAsync({ kind: "upload", path, base64, replace }).catch(() => {});
    }
    if (upload.current) upload.current.value = "";
  };

  const remove = (entry: DriveEntry) => {
    if (!keepsDraft(entry.path) || !window.confirm(entry.kind === "dir" ? `Delete the folder ${entry.path} and everything in it?` : `Delete ${entry.path}?`)) return;
    change.mutate({ kind: "delete", path: entry.path }, {
      onSuccess: () => {
        if (open === entry.path || open?.startsWith(`${entry.path}/`)) setOpen(null);
        if (folder === entry.path || folder.startsWith(`${entry.path}/`)) setFolder("");
      },
    });
  };

  const hidden = (path: string) => [...folded].some((f) => path.startsWith(`${f}/`));
  return (
    <section className="cr-drive" aria-label="Files">
      <h2 className="cr-section-heading">Files</h2>
      <p className="project-meta">
        Shared by every thread of this Adventure, outside git. Agents read and write them with their file tools at{" "}
        <code>{list.data?.root ?? "…"}/</code>
      </p>
      <div className="cr-drive-tools">
        <button onClick={() => setAsk({ kind: "file", value: join(folder, "notes.md") })}>New file</button>
        <button onClick={() => setAsk({ kind: "folder", value: join(folder, "folder") })}>New folder</button>
        <button onClick={() => upload.current?.click()}>Upload</button>
        <input ref={upload} type="file" multiple hidden aria-label="Upload files" onChange={(e) => void uploadFiles(e.currentTarget.files)} />
        {folder ? <span className="project-meta">into {folder}/</span> : null}
      </div>
      {ask ? (
        <form className="cr-drive-ask" onSubmit={submit}>
          <label>
            {ask.kind === "move" ? `Rename or move ${ask.from} to` : ask.kind === "file" ? "New file" : "New folder"}
            <input autoFocus value={ask.value} onChange={(e) => setAsk({ ...ask, value: e.currentTarget.value })}
              onKeyDown={(e) => e.key === "Escape" && setAsk(null)} />
          </label>
          <button type="submit">{ask.kind === "move" ? "Move" : "Create"}</button>
          <button type="button" onClick={() => setAsk(null)}>Cancel</button>
        </form>
      ) : null}
      {problem ? <p className="cr-mq-note" role="alert">{problem}</p> : null}
      {!list.data ? (
        <p className="project-muted">{list.error ? `Couldn't read the drive: ${list.error.message}` : "Loading files…"}</p>
      ) : (
        <div className="cr-drive-body">
          {!entries.length ? <p className="cr-empty">No files yet. Create one, upload one, or ask an agent to save notes here.</p> : <ul className="cr-drive-tree" aria-label="Drive files">
            {entries.filter((e) => !hidden(e.path)).map((entry) => (
              <li key={entry.path} style={{ paddingLeft: `${entry.path.split("/").length - 1}em` }}
                data-selected={entry.path === open || (entry.kind === "dir" && entry.path === folder) || undefined}>
                <button className="cr-drive-entry" title={entry.title ?? entry.path}
                  aria-expanded={entry.kind === "dir" ? !folded.has(entry.path) : undefined}
                  onClick={() => {
                    if (entry.kind === "file") {
                      if (entry.path !== open && open && !keepsDraft(open)) return;
                      setOpen(entry.path);
                      setFolder(parentOf(entry.path));
                    } else {
                      setFolder(entry.path);
                      const next = new Set(folded);
                      if (!next.delete(entry.path)) next.add(entry.path);
                      setFolded(next);
                    }
                  }}
                  onMouseEnter={() => {
                    if (entry.kind !== "file") return;
                    clearTimeout(dwell.current);
                    dwell.current = setTimeout(() => void client.prefetchQuery(driveFileQuery(api, projectId, entry.path)), PREFETCH_DWELL_MS);
                  }}
                  onMouseLeave={() => clearTimeout(dwell.current)}>
                  {entry.kind === "dir" ? `${folded.has(entry.path) ? "▸" : "▾"} ` : ""}
                  {entry.path.split("/").pop()}
                </button>
                <span className="cr-drive-meta">{entry.kind === "file" ? humanSize(entry.size) : ""}</span>
                <button className="cr-pm-more" title={`Rename or move ${entry.path}`} onClick={() => setAsk({ kind: "move", from: entry.path, value: entry.path })}>Rename</button>
                <button className="cr-pm-more" title={`Delete ${entry.path}`} onClick={() => remove(entry)}>Delete</button>
              </li>
            ))}
            {list.data.truncated ? <li className="project-muted">More files than shown: open the folder on the server.</li> : null}
          </ul>}
          {/* Kept open when the file leaves the listing (an agent deleted or moved it): its draft stays. */}
          {open ? <FileView key={open} api={api} projectId={projectId} path={open} editing={editing} /> : null}
        </div>
      )}
    </section>
  );
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/iu;

/** One file: rendered markdown, highlighted text, an image or a download; text files edit in place. */
function FileView({ api, projectId, path, editing }: { api: Api; projectId: string; path: string; editing: MutableRefObject<boolean> }) {
  const client = useQueryClient();
  const file = useQuery(driveFileQuery(api, projectId, path));
  const [draft, setDraft] = useState<{ text: string; base: string } | null>(null);
  const [conflict, setConflict] = useState<{ gone: boolean } | null>(null);
  useEffect(() => {
    editing.current = draft !== null;
    return () => void (editing.current = false);
  }, [editing, draft]);
  const save = useMutation({
    mutationFn: (input: { text: string; base: string }) => api.call("driveSave", { projectId, path, ...input }),
    onSuccess: (answer) => {
      if ("saved" in answer) {
        client.setQueryData(queryKeys.driveFile(projectId, path), answer.saved);
        setDraft(null);
        setConflict(null);
      } else {
        if (answer.conflict) client.setQueryData<DriveFile>(queryKeys.driveFile(projectId, path), answer.conflict);
        setConflict({ gone: !answer.conflict });
      }
    },
  });
  const f = file.data;
  if (!f) return <article className="cr-drive-file"><p className="project-muted">{file.error ? `Couldn't open ${path}: ${file.error.message}` : "Opening…"}</p></article>;
  const changedUnder = draft && f.version !== draft.base;
  // A failed read again (deleted, moved) keeps the last text on screen, said so.
  const notice = conflict?.gone ? "This file was deleted or moved since you opened it." : file.error ? `Couldn't read it again: ${file.error.message}`
    : conflict || changedUnder ? "This file changed since you opened it." : null;
  return (
    <article className="cr-drive-file" aria-label={path}>
      <header className="cr-drive-file-head">
        <strong>{path}</strong>
        <span className="project-meta">{humanSize(f.size)} · {new Date(f.mtimeMs).toLocaleString()}</span>
        {!draft && f.text !== null ? <button onClick={() => { setDraft({ text: f.text!, base: f.version }); setConflict(null); }}>Edit</button> : null}
        <a className="cr-link" href={rawUrl(projectId, path, "&download=1")} download>Download</a>
      </header>
      {!draft && file.error ? <p className="cr-mq-note" role="alert">{notice}</p> : null}
      {draft ? (
        <form onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
          {notice ? (
            <p className="cr-mq-note" role="alert">
              {notice} Saving won't overwrite it; your text stays here.{" "}
              {f.text !== null && !file.error && !conflict?.gone ? (
                <button type="button" className="cr-link" onClick={() => { setDraft({ text: f.text!, base: f.version }); setConflict(null); }}>
                  Load the latest (drops your edit)
                </button>
              ) : null}
            </p>
          ) : null}
          <textarea className="cr-drive-editor" aria-label={`Edit ${path}`} value={draft.text} spellCheck={false} readOnly={save.isPending}
            onChange={(e) => setDraft({ ...draft, text: e.currentTarget.value })} />
          {save.error ? <p className="cr-mq-note" role="alert">Couldn't save: {save.error.message}</p> : null}
          <div className="project-actions">
            <button type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</button>
            <button type="button" onClick={() => { setDraft(null); setConflict(null); }}>Cancel</button>
          </div>
        </form>
      ) : f.text !== null ? (
        /\.(md|markdown)$/iu.test(path) ? <Markdown content={f.text} /> : <SourceCode content={f.text} path={path} overflow="wrap" />
      ) : IMAGE.test(path) ? (
        <img className="cr-drive-image" src={rawUrl(projectId, path, `&v=${encodeURIComponent(f.version)}`)} alt={path} />
      ) : (
        <p className="project-muted">{f.size > 1024 * 1024 ? "Too large to show here" : "A binary file"}: download it to open it.</p>
      )}
    </article>
  );
}
