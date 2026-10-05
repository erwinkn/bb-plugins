import { useEffect, useState } from "react";
import { experimental_Diff as Diff, experimental_FileLink as FileLink, UrlLink, useRpc, type ExperimentalDiffFullFileContents } from "@get-bb/plugin-sdk/app";
import { EXTERNAL_ATTRIBUTE } from "../lib/link-interception";
import { cn } from "../lib/utils";
import { errorText, type Contract, type PullDetail, type PullFile } from "./shared";
import { Badge } from "./ui/badge";
import { Icon } from "./ui/icon";
const externalLink = { [EXTERNAL_ATTRIBUTE]: "" } as const;

export function FileSection({
  pull,
  file,
  environmentId,
  open,
  viewed,
  onToggleOpen,
  onToggleViewed,
}: {
  pull: PullDetail;
  file: PullFile;
  environmentId: string | null;
  open: boolean;
  viewed: boolean;
  onToggleOpen: () => void;
  onToggleViewed?: (viewed: boolean) => void;
}) {
  const rpc = useRpc<Contract>();
  const [contents, setContents] = useState<ExperimentalDiffFullFileContents | null>(null);
  const [contentsLoaded, setContentsLoaded] = useState(false);
  const [patch, setPatch] = useState(file.patch);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || contentsLoaded) return;
    let live = true;
    setError(null);
    const oldPath = file.status === "added" ? null : (file.previousPath ?? file.path);
    const newPath = file.status === "removed" ? null : file.path;
    rpc
      .call("getPullFile", { repo: pull.repo, number: pull.number, page: file.page, oldPath, oldRef: pull.baseRefOid, newPath, newRef: pull.headRefOid })
      .then((result) => {
        if (!live) return;
        setContentsLoaded(true);
        setPatch(result.patch ?? file.patch);
        setError(null);
        if (result.old === null && result.new === null) return;
        setContents({
          old: result.old ?? { path: file.previousPath ?? file.path, content: "" },
          new: result.new ?? { path: file.path, content: "" },
        });
      })
      .catch((error: unknown) => {
        if (live) { setContentsLoaded(true); setError(errorText(error)); }
      });
    return () => {
      live = false;
    };
  }, [rpc, open, file, pull.repo, pull.baseRefOid, pull.headRefOid, contentsLoaded]);

  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-card", viewed && "opacity-60")}>
      <div className="flex w-full items-center gap-2 px-3 py-2 hover:bg-accent/50">
        <button
          type="button"
          className="shrink-0 text-xs text-muted-foreground"
          aria-label={`${open ? "Collapse" : "Expand"} ${file.path} diff`}
          onClick={onToggleOpen}
        >
          {open ? "▾" : "▸"}
        </button>
        <Icon name="FileDiff" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {environmentId === null || file.status === "removed" ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={file.previousPath !== null ? `${file.previousPath} → ${file.path}` : file.path}>
            {file.path}
          </span>
        ) : (
          <FileLink
            className="min-w-0 flex-1 truncate font-mono text-xs text-foreground hover:underline"
            target={{ kind: "workspace", environmentId, path: file.path }}
          >
            {file.path}
          </FileLink>
        )}
        {file.status !== "modified" ? (
          <Badge variant="secondary" className="shrink-0 font-normal text-muted-foreground">
            {file.status}
          </Badge>
        ) : null}
        <span className="shrink-0 text-xs text-green-600 dark:text-green-400">+{file.additions}</span>
        <span className="shrink-0 text-xs text-red-600 dark:text-red-400">−{file.deletions}</span>
        {onToggleViewed ? <label className="flex shrink-0 items-center gap-1.5 pl-1 text-xs text-muted-foreground" title="Mark file as viewed">
          <input
            type="checkbox"
            checked={viewed}
            aria-label={`Mark ${file.path} as viewed`}
            onChange={(event) => onToggleViewed(event.target.checked)}
            className="size-3.5 accent-current"
          />
        </label> : null}
      </div>
      {open ? (
        error !== null ? <div className="border-t border-border px-3 py-2 text-xs"><p role="alert">{error}</p><button className="underline" onClick={() => setContentsLoaded(false)}>Retry file diff</button></div> :
        !contentsLoaded ? <p className="border-t border-border px-3 py-2 text-xs">Loading file diff…</p> :
        patch !== null ? (
          <div className="border-t border-border">
            <Diff patch={patch} path={file.path} experimental_fullFileContents={contents ?? undefined} />
          </div>
        ) : (
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            Inline diff unavailable, binary or too large. {" "}
            <UrlLink href={`${pull.url}/files`} className="underline" {...externalLink}>
              view on GitHub ↗
            </UrlLink>
          </p>
        )
      ) : null}
    </div>
  );
}

