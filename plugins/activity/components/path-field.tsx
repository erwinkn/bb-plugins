import { useEffect, useId, useRef, useState } from "react";
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { projectContract } from "../lib/project-contract";
import type { DirectoryListing } from "../lib/project-schema";
import { formButtonClass, formInputClass } from "./inline-form";

const MAX_SUGGESTIONS = 8;

/** Split "/a/b/pref" into the directory to list and the prefix to match. */
export function splitPath(value: string): {
  directory: string;
  prefix: string;
} {
  const index = value.lastIndexOf("/");
  if (index < 0) return { directory: "", prefix: value };
  return {
    directory: index === 0 ? "/" : value.slice(0, index),
    prefix: value.slice(index + 1),
  };
}

/** A listing remembered under the directory the user typed. The host may
 * report a resolved path (`/tmp` → `/private/tmp`); suggestions keep the
 * typed form so the field never rewrites itself. */
export interface Listing {
  requested: string;
  entries: DirectoryListing["entries"];
}

export function suggestionsFor(
  listing: Listing | null,
  value: string,
): string[] {
  if (!listing) return [];
  const { directory, prefix } = splitPath(value);
  if (listing.requested !== directory) return [];
  const lower = prefix.toLocaleLowerCase();
  const base = directory.replace(/\/+$/, "");
  return listing.entries
    .filter((entry) => entry.name.toLocaleLowerCase().startsWith(lower))
    .filter((entry) => lower.length > 0 || !entry.name.startsWith("."))
    .map((entry) => `${base}/${entry.name}`)
    .slice(0, MAX_SUGGESTIONS);
}

// A folder path on one host, with directory completion from the host and a
// native folder dialog. Suggestions list only directories.
export function PathField({
  rpc,
  hostId,
  value,
  onChange,
  onError,
}: {
  rpc: PluginRpcClient<typeof projectContract>;
  hostId: string;
  value: string;
  onChange: (path: string) => void;
  onError: (message: string) => void;
}) {
  const listId = useId();
  const [listing, setListing] = useState<Listing | null>(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const [picking, setPicking] = useState(false);
  const latest = useRef(0);
  const { directory } = splitPath(value);
  useEffect(() => {
    if (!directory) {
      setListing(null);
      return;
    }
    const request = ++latest.current;
    const timer = window.setTimeout(() => {
      rpc
        .call("listDirectory", { hostId, path: directory })
        .then((result) => {
          if (latest.current === request)
            setListing({ requested: directory, entries: result.entries });
        })
        .catch(() => {
          if (latest.current === request) setListing(null);
        });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [rpc, hostId, directory]);
  const suggestions = open ? suggestionsFor(listing, value) : [];
  const pick = (path: string) => {
    onChange(`${path.replace(/\/+$/, "")}/`);
    setHighlighted(-1);
  };
  return (
    <div className="relative flex min-w-0 flex-1 items-center gap-2">
      <input
        aria-label="Folder path"
        placeholder="/path/to/folder"
        role="combobox"
        aria-expanded={suggestions.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        value={value}
        spellCheck={false}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setHighlighted(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (!suggestions.length) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const delta = event.key === "ArrowDown" ? 1 : -1;
            setHighlighted(
              (index) =>
                (index + delta + suggestions.length) % suggestions.length,
            );
          } else if (
            (event.key === "Enter" || event.key === "Tab") &&
            highlighted >= 0
          ) {
            event.preventDefault();
            pick(suggestions[highlighted]!);
          } else if (event.key === "Escape") {
            event.stopPropagation();
            setOpen(false);
          }
        }}
        className={formInputClass}
      />
      <button
        type="button"
        disabled={picking}
        onClick={async () => {
          setPicking(true);
          try {
            const { path } = await rpc.call("pickFolder", { hostId });
            if (path) onChange(path);
          } catch (cause) {
            onError(
              cause instanceof Error
                ? cause.message
                : "Could not open a dialog.",
            );
          } finally {
            setPicking(false);
          }
        }}
        className={formButtonClass}
      >
        {picking ? "Choosing…" : "Browse…"}
      </button>
      {suggestions.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Folders"
          className="absolute inset-x-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-popover p-1 text-sm shadow-lg"
        >
          {suggestions.map((path, index) => (
            <li
              key={path}
              role="option"
              aria-selected={index === highlighted}
              // Mouse down runs before the input blurs and closes the list.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(path);
              }}
              className={`cursor-default truncate rounded px-2 py-1 ${index === highlighted ? "bg-accent" : "hover:bg-accent"}`}
            >
              {path}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
