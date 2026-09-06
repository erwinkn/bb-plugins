import { useEffect, useMemo, useRef, useState } from "react";
import { ancestorsOf, buildTree, filterTree, type FlatEntry, type TreeNode } from "@/lib/file-tree";
import { copyText } from "@/lib/editor-commands";
import { cn } from "@/lib/utils";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { ChevronIcon, FileIcon, PanelLeftCloseIcon } from "./icons";

export interface FileTreeProps {
  entries: readonly FlatEntry[];
  root: string;
  label: string;
  isLoading: boolean;
  error: string | null;
  truncated: boolean;
  activePath: string | null;
  onOpenFile: (path: string, options: { newTab: boolean }) => void;
  onClose: () => void;
  onRefresh: () => void;
}

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
  onClose,
  onRefresh,
}: FileTreeProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
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

  const absolutePathOf = (relative: string) =>
    root === "" ? relative : root.includes("\\") ? `${root}\\${relative.replace(/\//g, "\\")}` : `${root}/${relative}`;

  const openMenu = (event: React.MouseEvent, node: TreeNode) => {
    event.preventDefault();
    const items = [
      ...(node.kind === "file"
        ? [{ label: "Open in new tab", onSelect: () => onOpenFile(node.path, { newTab: true }) }]
        : []),
      { label: "Copy absolute path", onSelect: () => void copyText(absolutePathOf(node.path), "Absolute path copied") },
      { label: "Copy relative path", onSelect: () => void copyText(node.path, "Relative path copied") },
      { label: "Copy name", onSelect: () => void copyText(node.name, "Name copied") },
    ];
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-recessed" data-testid="file-tree">
      <div className="flex h-9 shrink-0 items-center gap-1 px-2">
        <span className="min-w-0 flex-1 truncate px-1 text-xs font-medium text-muted-foreground" title={root}>
          {label}
        </span>
        <TreeButton label="Refresh file list" onClick={onRefresh}>
          <RefreshGlyph />
        </TreeButton>
        <TreeButton label="Hide file tree" onClick={onClose}>
          <PanelLeftCloseIcon />
        </TreeButton>
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
            "h-6 w-full min-w-0 rounded-sm bg-state-hover px-2 text-xs text-foreground",
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
        ) : filtered.nodes.length === 0 ? (
          <Message>{query.trim() === "" ? "No files" : `No files match “${query}”`}</Message>
        ) : (
          <Rows
            activePath={activePath}
            activeRowRef={activeRowRef}
            expanded={effectiveExpanded}
            level={0}
            nodes={filtered.nodes}
            onContextMenu={openMenu}
            onOpenFile={onOpenFile}
            onToggle={toggle}
          />
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
      onClick={onClick}
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

function RefreshGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-3.5" aria-hidden>
      <path d="M3 2v6h6M3.51 15a9 9 0 102.13-9.36L3 8" />
    </svg>
  );
}

function Rows({
  activePath,
  activeRowRef,
  expanded,
  level,
  nodes,
  onContextMenu,
  onOpenFile,
  onToggle,
}: {
  activePath: string | null;
  activeRowRef: React.RefObject<HTMLButtonElement | null>;
  expanded: ReadonlySet<string>;
  level: number;
  nodes: readonly TreeNode[];
  onContextMenu: (event: React.MouseEvent, node: TreeNode) => void;
  onOpenFile: (path: string, options: { newTab: boolean }) => void;
  onToggle: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const isDirectory = node.kind === "directory";
        const isOpen = isDirectory && expanded.has(node.path);
        const isActive = !isDirectory && node.path === activePath;
        return (
          <div key={node.path} role="treeitem" aria-expanded={isDirectory ? isOpen : undefined}>
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
              <span className="flex size-4 shrink-0 items-center justify-center text-subtle-foreground">
                {isDirectory ? (
                  <ChevronIcon open={isOpen} />
                ) : (
                  <FileIcon path={node.name} className={cn("size-3.5", isActive ? "text-file-accent" : "text-subtle-foreground")} />
                )}
              </span>
              <span className="truncate">{node.name}</span>
            </button>
            {isDirectory && isOpen ? (
              <Rows
                activePath={activePath}
                activeRowRef={activeRowRef}
                expanded={expanded}
                level={level + 1}
                nodes={node.children}
                onContextMenu={onContextMenu}
                onOpenFile={onOpenFile}
                onToggle={onToggle}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function Message({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <p className={cn("px-3 py-2 text-xs", tone === "error" ? "text-destructive" : "text-muted-foreground")}>
      {children}
    </p>
  );
}
