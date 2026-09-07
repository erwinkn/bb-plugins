// Searchable multi-select of workspace paths and links. Typing only updates
// the result list; the input and caret are never re-mounted. Mouse and
// keyboard share one active row.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { type Reference, referenceLabel, referenceName } from "@/lib/model";
import type { PathHit } from "@/hooks/useQuestions";
import { IconButton, INPUT_TEXT_CLASS } from "./primitives";

interface Candidate {
  reference: Reference;
  name: string;
  path: string;
}

function referenceIcon(reference: Reference): IconName {
  if (reference.kind === "url") return "ExternalLink";
  if (reference.kind === "workspace" && reference.entryKind === "directory") return "Folder";
  const path = referenceLabel(reference);
  if (/\.(tsx?|jsx?|json|svg|css|html|py|rs|go)$/i.test(path)) return "Code";
  return "File";
}

function sameReference(a: Reference, b: Reference): boolean {
  return referenceLabel(a) === referenceLabel(b) && a.kind === b.kind;
}

export function ReferenceBadge({
  reference,
  onOpen,
  onRemove,
}: {
  reference: Reference;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  const label = referenceLabel(reference);
  return (
    <span
      className="inline-flex max-w-full items-center gap-[5px] rounded-[5px] bg-[var(--surface-recessed)] py-0.5 pl-[7px] pr-1 text-[12px]"
      aria-label={label}
    >
      <Icon name={referenceIcon(reference)} className="size-4 shrink-0 text-[var(--subtle-foreground)]" />
      <button
        type="button"
        title={label}
        className="cursor-pointer truncate border-0 bg-transparent p-0 text-[12px] font-normal text-foreground hover:underline hover:underline-offset-2"
        onClick={onOpen}
      >
        {referenceName(reference)}
      </button>
      {onRemove ? <IconButton icon="X" label={`Remove ${label}`} size={20} onClick={onRemove} /> : null}
    </span>
  );
}

export function useOpenReference() {
  const navigate = useBbNavigate();
  return useCallback(
    (reference: Reference): boolean => {
      if (reference.kind === "url") return navigate.openUrl(reference.url);
      if (reference.kind === "workspace") {
        return navigate.experimental_openFilePreview({
          target: { kind: "workspace", environmentId: reference.environmentId, path: reference.path },
          location: null,
        });
      }
      return false;
    },
    [navigate],
  );
}

export function ReferencePicker({
  questionId,
  references,
  onChange,
  search,
}: {
  questionId: string;
  references: Reference[];
  onChange: (next: Reference[]) => void;
  search: (query: string) => Promise<{
    environmentId: string | null;
    hostId: string | null;
    hits: PathHit[];
    unavailable: string | null;
  }>;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [serverHits, setServerHits] = useState<{ query: string; hits: Candidate[] }>({ query: "", hits: [] });
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  // Server hits count only when they answer the current query; a pasted
  // link or path is always selectable.
  const hits: Candidate[] = [
    ...(serverHits.query === query ? serverHits.hits : []),
  ];
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);
  const openReference = useOpenReference();

  const runSearch = useCallback(
    (value: string) => {
      const seq = (requestSeq.current += 1);
      if (value.trim() === "") {
        setSearching(false);
        setUnavailable(null);
        setServerHits({ query: value, hits: [] });
        return;
      }
      setUnavailable(null);
      setSearching(true);
      search(value).then(
        (result) => {
          if (seq !== requestSeq.current) return;
          setSearching(false);
          setUnavailable(result.unavailable);
          const environmentId = result.environmentId;
          const candidates: Candidate[] = environmentId
            ? result.hits.map((hit) => ({
                reference: {
                  kind: "workspace",
                  path: hit.path,
                  entryKind: hit.kind,
                  environmentId,
                  hostId: result.hostId,
                },
                name: hit.name,
                path: hit.path,
              }))
            : [];
          setServerHits({ query: value, hits: candidates });
          setActive((current) => Math.min(current, Math.max(candidates.length, 0)));
        },
        () => {
          if (seq !== requestSeq.current) return;
          setSearching(false);
          setUnavailable("File search is unavailable right now.");
          setServerHits({ query: value, hits: [] });
        },
      );
    },
    [search],
  );

  useEffect(() => {
    if (!open) return;
    // Any in-flight answer to an older query is stale from this moment.
    requestSeq.current += 1;
    const timer = setTimeout(() => runSearch(query), 150);
    return () => clearTimeout(timer);
  }, [open, query, runSearch]);

  useEffect(() => {
    if (!open || hits.length === 0) return;
    const row = document.getElementById(`${listId}-${active}`);
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
  }, [active, hits.length, listId, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const isSelected = (candidate: Candidate) => references.some((item) => sameReference(item, candidate.reference));
  const toggle = (candidate: Candidate) => {
    onChange(
      isSelected(candidate)
        ? references.filter((item) => !sameReference(item, candidate.reference))
        : [...references, candidate.reference],
    );
    setOpen(true);
    inputRef.current?.focus();
  };

  const activeId = open && hits.length > 0 ? `${listId}-${active}` : undefined;

  return (
    <div ref={rootRef} className="mt-2 w-full max-w-[28rem]" data-picker={questionId}>
      <div className="rounded-md border border-border bg-background focus-within:ring-1 focus-within:ring-ring">
      {references.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 px-2 pt-2" aria-label="Selected files">
          {references.map((reference) => (
            <ReferenceBadge
              key={`${reference.kind}:${referenceLabel(reference)}`}
              reference={reference}
              onOpen={() => openReference(reference)}
              onRemove={() => onChange(references.filter((item) => item !== reference))}
            />
          ))}
        </div>
      ) : null}
      <div className="relative flex items-center">
        <Icon name="Search" className="pointer-events-none absolute left-2.5 size-4 text-[var(--subtle-foreground)]" />
        <input
          ref={inputRef}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-label="Search files"
          placeholder="Search files"
          autoComplete="off"
          className={cn("w-full min-w-0 rounded-md border-0 bg-transparent py-2 pl-[34px] pr-[34px] text-foreground placeholder:text-[var(--subtle-foreground)] focus:outline-none", INPUT_TEXT_CLASS)}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!open) {
                setOpen(true);
                return;
              }
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((current) => Math.max(0, Math.min(hits.length - 1, current + step)));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const candidate = hits[active];
              if (open && candidate) toggle(candidate);
            } else if (event.key === "Escape" && open) {
              event.preventDefault();
              setOpen(false);
            }
          }}
        />
        <button
          type="button"
          aria-label={open ? "Close file search" : "Open file search"}
          aria-expanded={open}
          className="absolute inset-y-0 right-1 my-auto grid size-7 cursor-pointer place-items-center border-0 bg-transparent text-[var(--subtle-foreground)]"
          onClick={() => {
            if (open) {
              setOpen(false);
              return;
            }
            setOpen(true);
            inputRef.current?.focus();
          }}
        >
          <Icon name="ChevronDown" className="size-4" />
        </button>
      </div>
      </div>
      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Files"
          aria-multiselectable="true"
          className="mt-1 max-h-[220px] overflow-y-auto rounded-md border border-border bg-background p-1"
        >
          {hits.length === 0 ? (
            <div className="p-2.5 text-[12px] text-[var(--subtle-foreground)]">
              {query.trim() === "" ? "Type to search files" : searching || serverHits.query !== query ? "Searching…" : (unavailable ?? "No matching files")}
            </div>
          ) : (
            hits.map((candidate, index) => {
              const selected = isSelected(candidate);
              return (
                <button
                  key={`${candidate.reference.kind}:${candidate.path}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  id={`${listId}-${index}`}
                  aria-selected={selected}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 py-[7px] text-left text-[12px] font-normal text-foreground",
                    index === active && "bg-[var(--state-hover)]",
                  )}
                  onPointerMove={() => {
                    if (index !== active) setActive(index);
                  }}
                  onClick={() => toggle(candidate)}
                >
                  <Icon name={referenceIcon(candidate.reference)} className="size-4 shrink-0 text-[var(--subtle-foreground)]" />
                  <span className="max-w-[48%] shrink-0 truncate font-normal">{candidate.name}</span>
                  <span className="truncate text-[var(--subtle-foreground)]">{candidate.path}</span>
                  <span className="ml-auto w-3 shrink-0 text-center" aria-hidden="true">
                    {selected ? "✓" : ""}
                  </span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
