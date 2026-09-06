import { useEffect, useMemo, useRef, useState } from "react";
import { ancestorsOf, buildTree, filterTree, type FlatEntry, type TreeNode } from "@/lib/file-tree";
import { copyText } from "@/lib/editor-commands";
import { cn } from "@/lib/utils";
import { ContextMenu, type MenuState } from "./ContextMenu";
import { ChevronIcon, FileAddGlyph, FileIcon, FolderAddGlyph, FolderIcon, FolderOpenGlyph, RefreshGlyph } from "./icons";

export type CreateKind = "file" | "directory";

export interface FileTreeProps {
  entries: readonly FlatEntry[];
  root: string;
  label: string;
  isLoading: boolean;
  error: string | null;
  truncated: boolean;
  activePath: string | null;
  onOpenFile: (path: string, options: { newTab: boolean }) => void;
  onRefresh: () => void;
  /** Resolves when the entry exists; rejects with a message to show inline. */
  onCreate: (path: string, kind: CreateKind) => Promise<void>;
  onRename: (path: string, newPath: string, kind: CreateKind) => Promise<void>;
  onDelete: (path: string, kind: CreateKind) => Promise<void>;
}

interface Draft {
  parent: string;
  kind: CreateKind;
}

/** A row in an editing state: renaming, or awaiting delete confirmation. */
type RowEdit = { kind: "rename"; path: string } | { kind: "delete"; path: string };

const INDENT_PER_LEVEL_PX = 12;

export function FileTree({
  entries,
  root,
  label,
  isLoading,
  error,
  truncated,
  activePath,
  onOpenFile,
  onRefresh,
  onCreate,
  onRename,
  onDelete,
}: FileTreeProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [rowEdit, setRowEdit] = useState<RowEdit | null>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const tree = useMemo(() => buildTree(entries), [entries]);
  const filtered = useMemo(() => filterTree(tree, query), [tree, query]);

  useEffect(() => {
    if (activePath === null) return;
    setExpanded((current) => {
      const ancestors = ancestorsOf(activePath);
      if (ancestors.every((ancestor) => current.has(ancestor))) return current;
      const next = new Set(current);
      for (const ancestor of ancestors) next.add(ancestor);
      return next;
    });
  }, [activePath]);

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activePath, entries.length]);

  const effectiveExpanded = useMemo(
    () => (filtered.expand.size === 0 ? expanded : new Set([...expanded, ...filtered.expand])),
    [expanded, filtered.expand],
  );

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const startDraft = (parent: string, kind: CreateKind) => {
    if (parent !== "") setExpanded((current) => (current.has(parent) ? current : new Set([...current, parent])));
    setDraft({ parent, kind });
  };

  const absolutePathOf = (relative: string) =>
    root === "" ? relative : root.includes("\\") ? `${root}\\${relative.replace(/\//g, "\\")}` : `${root}/${relative}`;

  const openMenu = (event: React.MouseEvent, node: TreeNode) => {
    event.preventDefault();
    const parent = node.kind === "directory" ? node.path : node.path.slice(0, Math.max(node.path.lastIndexOf("/"), 0));
    setMenu({
      x: event.clientX,
      y: event.clientY,
      anchor: event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined,
      items: [
        ...(node.kind === "file" ? [{ label: "Open in new tab", onSelect: () => onOpenFile(node.path, { newTab: true }) }] : []),
        { label: "New file…", onSelect: () => startDraft(parent, "file") },
        { label: "New folder…", onSelect: () => startDraft(parent, "directory") },
        { type: "separator" as const },
        { label: "Rename…", onSelect: () => setRowEdit({ kind: "rename", path: node.path }) },
        { label: "Delete…", onSelect: () => setRowEdit({ kind: "delete", path: node.path }) },
        { type: "separator" as const },
        { label: "Copy absolute path", onSelect: () => void copyText(absolutePathOf(node.path), "Absolute path copied") },
        { label: "Copy relative path", onSelect: () => void copyText(node.path, "Relative path copied") },
        { label: "Copy name", onSelect: () => void copyText(node.name, "Name copied") },
      ],
    });
  };

  return (
    <div className="group/tree flex h-full min-h-0 flex-col bg-background" data-testid="file-tree">
      <div className="flex h-9 shrink-0 items-center gap-0.5 pr-1.5 pl-3">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={root}>
          {label}
        </span>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/tree:opacity-100 focus-within:opacity-100">
          <TreeButton label="Refresh" onClick={onRefresh}>
            <RefreshGlyph className={cn(isLoading && "animate-spin")} />
          </TreeButton>
          <TreeButton label="New file" onClick={() => startDraft("", "file")}>
            <FileAddGlyph />
          </TreeButton>
          <TreeButton label="New folder" onClick={() => startDraft("", "directory")}>
            <FolderAddGlyph />
          </TreeButton>
        </div>
      </div>
      <div className="px-2 pb-1.5">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            if (query !== "") setQuery("");
            else inputRef.current?.blur();
          }}
          placeholder="Filter files…"
          aria-label="Filter files"
          spellCheck={false}
          className={cn(
            "h-6 w-full min-w-0 rounded-sm bg-surface-recessed px-2 text-xs text-foreground",
            "placeholder:text-muted-foreground",
            "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          )}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2" role="tree">
        {error !== null ? (
          <Message tone="error">{error}</Message>
        ) : isLoading && entries.length === 0 ? (
          <Message>Loading files…</Message>
        ) : filtered.nodes.length === 0 && draft === null ? (
          <Message>{query.trim() === "" ? "No files" : `No files match “${query}”`}</Message>
        ) : (
          <>
            {draft !== null && draft.parent === "" ? (
              <DraftRow draft={draft} level={0} onCancel={() => setDraft(null)} onCreate={onCreate} onDone={() => setDraft(null)} />
            ) : null}
            <Rows
              activePath={activePath}
              activeRowRef={activeRowRef}
              draft={draft}
              rowEdit={rowEdit}
              expanded={effectiveExpanded}
              level={0}
              nodes={filtered.nodes}
              onContextMenu={openMenu}
              onOpenFile={onOpenFile}
              onStartDraft={startDraft}
              onToggle={toggle}
              onCancelDraft={() => setDraft(null)}
              onCreate={onCreate}
              onEndRowEdit={() => setRowEdit(null)}
              onRename={onRename}
              onDelete={onDelete}
            />
          </>
        )}
        {truncated && error === null ? (
          <Message>Showing the first {entries.length.toLocaleString()} entries; this project is larger.</Message>
        ) : null}
      </div>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

function TreeButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      title={label}
      aria-label={label}
      className={cn(
        "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md",
        "text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
      )}
    >
      {children}
    </button>
  );
}

function DraftRow({
  draft,
  level,
  onCancel,
  onCreate,
  onDone,
}: {
  draft: Draft;
  level: number;
  onCancel: () => void;
  onCreate: (path: string, kind: CreateKind) => Promise<void>;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed === "" || busy) return;
    if (trimmed.includes("..") || trimmed.startsWith("/")) {
      setError("Use a name inside this folder");
      return;
    }
    setBusy(true);
    try {
      await onCreate(draft.parent === "" ? trimmed : `${draft.parent}/${trimmed}`, draft.kind);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create it");
      setBusy(false);
    }
  };
  return (
    <div className="px-2" style={{ paddingLeft: 6 + level * INDENT_PER_LEVEL_PX }}>
      <div className="flex h-6 items-center gap-1">
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {draft.kind === "directory" ? <FolderIcon /> : <FileIcon path={name || "file"} />}
        </span>
        <input
          ref={ref}
          type="text"
          value={name}
          disabled={busy}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          onBlur={() => {
            if (name.trim() === "") onCancel();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            }
          }}
          placeholder={draft.kind === "directory" ? "folder name" : "file name"}
          aria-label={draft.kind === "directory" ? "New folder name" : "New file name"}
          spellCheck={false}
          className={cn(
            "h-5 min-w-0 flex-1 rounded-sm bg-surface-recessed px-1.5 text-[13px] text-foreground",
            "ring-1 ring-ring focus:outline-none",
            error !== null && "ring-destructive",
          )}
        />
      </div>
      {error !== null ? <p className="pb-1 pl-5 text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}

interface RowsProps {
  activePath: string | null;
  activeRowRef: React.RefObject<HTMLButtonElement | null>;
  draft: Draft | null;
  rowEdit: RowEdit | null;
  expanded: ReadonlySet<string>;
  level: number;
  nodes: readonly TreeNode[];
  onContextMenu: (event: React.MouseEvent, node: TreeNode) => void;
  onOpenFile: (path: string, options: { newTab: boolean }) => void;
  onStartDraft: (parent: string, kind: CreateKind) => void;
  onToggle: (path: string) => void;
  onCancelDraft: () => void;
  onCreate: (path: string, kind: CreateKind) => Promise<void>;
  onEndRowEdit: () => void;
  onRename: (path: string, newPath: string, kind: CreateKind) => Promise<void>;
  onDelete: (path: string, kind: CreateKind) => Promise<void>;
}

function Rows(props: RowsProps) {
  const { activePath, activeRowRef, draft, rowEdit, expanded, level, nodes, onContextMenu, onOpenFile, onStartDraft, onToggle, onCancelDraft, onCreate, onEndRowEdit, onRename, onDelete } = props;
  return (
    <>
      {nodes.map((node) => {
        const isDirectory = node.kind === "directory";
        const isOpen = isDirectory && expanded.has(node.path);
        const isActive = !isDirectory && node.path === activePath;
        if (rowEdit?.path === node.path) {
          return (
            <div key={node.path} role="treeitem">
              {rowEdit.kind === "rename" ? (
                <RenameRow node={node} level={level} onCancel={onEndRowEdit} onRename={onRename} />
              ) : (
                <DeleteRow node={node} level={level} onCancel={onEndRowEdit} onDelete={onDelete} />
              )}
              {isDirectory && isOpen ? <Rows {...props} level={level + 1} nodes={node.children} /> : null}
            </div>
          );
        }
        return (
          <div key={node.path} role="treeitem" aria-expanded={isDirectory ? isOpen : undefined}>
            <div className="group/row relative">
              <button
                type="button"
                ref={isActive ? activeRowRef : undefined}
                onClick={(event) => {
                  if (isDirectory) onToggle(node.path);
                  else onOpenFile(node.path, { newTab: event.metaKey || event.ctrlKey });
                }}
                onContextMenu={(event) => onContextMenu(event, node)}
                title={node.path}
                aria-current={isActive ? "true" : undefined}
                style={{ paddingLeft: 6 + level * INDENT_PER_LEVEL_PX }}
                className={cn(
                  "flex h-6 w-full cursor-pointer items-center gap-1 pr-2 text-left text-[13px] leading-6",
                  "hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none",
                  isActive ? "bg-state-hover text-foreground" : "text-foreground/85",
                )}
              >
                <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
                  {isDirectory ? <ChevronIcon open={isOpen} /> : null}
                </span>
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {isDirectory ? (
                    isOpen ? (
                      <FolderOpenGlyph className="text-muted-foreground" />
                    ) : (
                      <FolderIcon className="text-muted-foreground" />
                    )
                  ) : (
                    <FileIcon path={node.name} className={isActive ? "text-file-accent" : "text-muted-foreground"} />
                  )}
                </span>
                <span className="truncate">{node.name}</span>
              </button>
              {isDirectory ? (
                <div className="absolute top-0 right-1 flex h-6 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
                  <RowButton label={`New file in ${node.name}`} onClick={() => onStartDraft(node.path, "file")}>
                    <FileAddGlyph />
                  </RowButton>
                  <RowButton label={`New folder in ${node.name}`} onClick={() => onStartDraft(node.path, "directory")}>
                    <FolderAddGlyph />
                  </RowButton>
                </div>
              ) : null}
            </div>
            {isDirectory && isOpen ? (
              <>
                {draft !== null && draft.parent === node.path ? (
                  <DraftRow draft={draft} level={level + 1} onCancel={onCancelDraft} onCreate={onCreate} onDone={onCancelDraft} />
                ) : null}
                <Rows {...props} level={level + 1} nodes={node.children} />
              </>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function RenameRow({
  node,
  level,
  onCancel,
  onRename,
}: {
  node: TreeNode;
  level: number;
  onCancel: () => void;
  onRename: (path: string, newPath: string, kind: CreateKind) => Promise<void>;
}) {
  const [name, setName] = useState(node.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const input = ref.current;
    if (input === null) return;
    input.focus();
    const dot = node.kind === "file" ? node.name.lastIndexOf(".") : -1;
    input.setSelectionRange(0, dot > 0 ? dot : node.name.length);
  }, [node]);
  const submit = async () => {
    const trimmed = name.trim();
    if (busy) return;
    if (trimmed === "" || trimmed === node.name) {
      onCancel();
      return;
    }
    if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
      setError("Use a plain name; moving between folders is not supported here");
      return;
    }
    setBusy(true);
    try {
      const parent = node.path.slice(0, Math.max(node.path.lastIndexOf("/"), 0));
      await onRename(node.path, parent === "" ? trimmed : `${parent}/${trimmed}`, node.kind);
      onCancel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rename it");
      setBusy(false);
    }
  };
  return (
    <div className="px-2" style={{ paddingLeft: 6 + level * INDENT_PER_LEVEL_PX }}>
      <div className="flex h-6 items-center gap-1">
        <span className="flex size-3.5 shrink-0" />
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {node.kind === "directory" ? <FolderIcon /> : <FileIcon path={name || node.name} />}
        </span>
        <input
          ref={ref}
          type="text"
          value={name}
          disabled={busy}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          onBlur={() => {
            if (!busy && error === null) void submit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            }
          }}
          aria-label={`Rename ${node.name}`}
          spellCheck={false}
          className={cn(
            "h-5 min-w-0 flex-1 rounded-sm bg-surface-recessed px-1.5 text-[13px] text-foreground",
            "ring-1 ring-ring focus:outline-none",
            error !== null && "ring-destructive",
          )}
        />
      </div>
      {error !== null ? <p className="pb-1 pl-9 text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}

function DeleteRow({
  node,
  level,
  onCancel,
  onDelete,
}: {
  node: TreeNode;
  level: number;
  onCancel: () => void;
  onDelete: (path: string, kind: CreateKind) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onDelete(node.path, node.kind);
      onCancel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete it");
      setBusy(false);
    }
  };
  const count = node.kind === "directory" ? countFiles(node) : 0;
  return (
    <div
      className="bg-destructive/10 px-2 py-1 text-xs text-foreground"
      style={{ paddingLeft: 6 + level * INDENT_PER_LEVEL_PX }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <p className="truncate">
        Delete <span className="font-medium">{node.name}</span>
        {node.kind === "directory" ? ` and ${count} file${count === 1 ? "" : "s"}` : ""}?
      </p>
      <div className="mt-1 flex gap-2">
        <button
          ref={confirmRef}
          type="button"
          disabled={busy}
          onClick={() => void confirm()}
          className="cursor-pointer rounded-sm bg-destructive px-2 py-0.5 text-[11px] font-medium text-white hover:opacity-90 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="cursor-pointer rounded-sm px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
        >
          Cancel
        </button>
      </div>
      {error !== null ? <p className="pt-1 text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}

function countFiles(node: TreeNode): number {
  return node.children.reduce((total, child) => total + (child.kind === "file" ? 1 : countFiles(child)), 0);
}

function RowButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      title={label}
      aria-label={label}
      className="flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
    >
      {children}
    </button>
  );
}

function Message({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <p className={cn("px-3 py-2 text-xs", tone === "error" ? "text-destructive" : "text-muted-foreground")}>
      {children}
    </p>
  );
}
