import { useEffect, useMemo, useRef, useState } from "react";
import { quickOpenMatches, type FlatEntry } from "@/lib/file-tree";
import { cn } from "@/lib/utils";
import { FileIcon, SearchIcon } from "./icons";

const LIMIT = 40;

export function QuickOpen({
  entries,
  onOpen,
  onClose,
}: {
  entries: readonly FlatEntry[];
  onOpen: (path: string, options: { newTab: boolean }) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const matches = useMemo(() => quickOpenMatches(entries, query, LIMIT), [entries, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => setIndex(0), [query]);

  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const choose = (event: { metaKey: boolean; ctrlKey: boolean }) => {
    const match = matches[index];
    if (match === undefined) return;
    onOpen(match.path, { newTab: event.metaKey || event.ctrlKey });
    onClose();
  };

  return (
    <div
      className="absolute inset-0 z-30 flex justify-center bg-background/40 pt-[6vh] backdrop-blur-[1px]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Quick open"
        className="flex h-fit max-h-[70%] w-[min(560px,92%)] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <SearchIcon className="text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setIndex((current) => Math.min(current + 1, Math.max(matches.length - 1, 0)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setIndex((current) => Math.max(current - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(event);
              }
            }}
            placeholder="Go to file…"
            aria-label="Go to file"
            spellCheck={false}
            autoComplete="off"
            className="h-10 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <kbd className="rounded border border-border px-1 text-[10px] text-muted-foreground">esc</kbd>
        </div>
        <ul ref={listRef} role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1">
          {matches.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-muted-foreground">
              {entries.length === 0 ? "Loading files…" : "No matching files"}
            </li>
          ) : (
            matches.map((entry, i) => {
              const slash = entry.path.lastIndexOf("/");
              const name = entry.path.slice(slash + 1);
              const directory = slash === -1 ? "" : entry.path.slice(0, slash);
              return (
                <li
                  key={entry.path}
                  role="option"
                  aria-selected={i === index}
                  onPointerMove={() => setIndex(i)}
                  onClick={(event) => {
                    setIndex(i);
                    onOpen(entry.path, { newTab: event.metaKey || event.ctrlKey });
                    onClose();
                  }}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                    i === index ? "bg-state-hover text-foreground" : "text-foreground/85",
                  )}
                >
                  <FileIcon path={name} className="text-subtle-foreground" />
                  <span className="truncate">{name}</span>
                  {directory !== "" ? (
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{directory}</span>
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
