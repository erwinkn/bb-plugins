import { useEffect, useMemo, useRef, useState } from "react";
import { codeThemesOfType, FOLLOW_BB, type ThemeType } from "@/lib/themes";
import { cn } from "@/lib/utils";
import { CheckIcon, SearchIcon } from "./icons";

interface Choice {
  id: string;
  label: string;
  detail: string | null;
}

/**
 * Picks the code theme for BB's current color mode. Moving through the list
 * previews the theme in the editor; Enter or a click keeps it, Esc puts the
 * saved theme back. "Follow BB" is BB's own code theme, so the editor keeps
 * matching BB's previews.
 */
export function ThemePicker({
  mode,
  bbThemeName,
  current,
  onPreview,
  onChoose,
  onClose,
}: {
  mode: ThemeType;
  /** BB's current code theme name, shown on the "Follow BB" row. */
  bbThemeName: string;
  /** The saved setting for `mode`. */
  current: string;
  onPreview: (id: string | null) => void;
  onChoose: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const choices = useMemo<Choice[]>(
    () => [
      { id: FOLLOW_BB, label: "Follow BB", detail: bbThemeName },
      ...codeThemesOfType(mode).map((entry) => ({ id: entry.id, label: entry.label, detail: null })),
    ],
    [bbThemeName, mode],
  );
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return choices;
    return choices.filter((choice) => `${choice.label} ${choice.id} ${choice.detail ?? ""}`.toLowerCase().includes(needle));
  }, [choices, query]);

  const [index, setIndex] = useState(() => Math.max(0, choices.findIndex((choice) => choice.id === current)));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: "nearest" });
    const choice = matches[index];
    onPreview(choice === undefined ? null : choice.id);
  }, [index, matches, onPreview]);

  const choose = (i: number) => {
    const choice = matches[i];
    if (choice === undefined) return;
    onChoose(choice.id);
    onClose();
  };

  const cancel = () => {
    onPreview(null);
    onClose();
  };

  return (
    <div
      className="absolute inset-0 z-30 flex justify-center pt-[6vh]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <div
        role="dialog"
        aria-label="Code theme"
        className="flex h-fit max-h-[70%] w-[min(420px,92%)] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
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
                cancel();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setIndex((value) => Math.min(value + 1, Math.max(matches.length - 1, 0)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setIndex((value) => Math.max(value - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(index);
              }
            }}
            placeholder={`${mode === "dark" ? "Dark" : "Light"} code theme…`}
            aria-label="Code theme"
            spellCheck={false}
            autoComplete="off"
            className="h-10 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <kbd className="rounded border border-border px-1 text-[10px] text-muted-foreground">esc</kbd>
        </div>
        <ul ref={listRef} role="listbox" aria-label="Code themes" className="min-h-0 flex-1 overflow-y-auto p-1">
          {matches.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-muted-foreground">No matching themes</li>
          ) : (
            matches.map((choice, i) => (
              <li
                key={choice.id}
                role="option"
                aria-selected={i === index}
                onPointerMove={() => setIndex(i)}
                onClick={() => choose(i)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                  i === index ? "bg-state-hover text-foreground" : "text-foreground/85",
                )}
              >
                <span className="truncate">{choice.label}</span>
                {choice.detail !== null ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{choice.detail}</span> : null}
                {choice.id === current ? <CheckIcon className="ml-auto shrink-0 text-muted-foreground" /> : null}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
