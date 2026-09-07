/**
 * The two header rows of the Changes tab. The first row says what is
 * compared and how; the second row says which file is open and what can be
 * done with it. Both use BB's chrome sizes, so the tab sits beside the Files
 * tab without looking different.
 */
import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { cn } from "@/lib/utils";
import type { DiffEntry, DiffTarget } from "@/lib/diff-contract";
import {
  comparisonBranch,
  describeTarget,
  isBranchRef,
  isCommitHash,
  needsBranch,
  shortSha,
  type ChangeSummary,
  type DiffLayout,
  type DiffScope,
  type DiffViewPrefs,
} from "@/lib/diff-view-state";
import type { EditorPrefs } from "@/lib/editor-options";
import { ContextMenu, menuAt, type MenuItem, type MenuState } from "./ContextMenu";
import { DiffScopeMenu, type ScopeMenuItem } from "./DiffScopeMenu";
import type { SetPref } from "./EditorPane";
import { ToolbarButton } from "./Toolbar";
import {
  BranchGlyph,
  CommitGlyph,
  CompareGlyph,
  FileAddGlyph,
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronIcon,
  CloseIcon,
  ExternalIcon,
  FileIcon,
  MoreIcon,
  RefreshGlyph,
  SidebarLeftGlyph,
  SidebarRightGlyph,
} from "./icons";

const ROW_CLASS = "flex h-9 shrink-0 items-center gap-0.5 border-b border-border/60 bg-background pr-1.5 pl-1";

export interface ScopeBarProps {
  threadId: string;
  target: DiffTarget;
  baseBranch: string | null;
  summary: ChangeSummary | null;
  isLoading: boolean;
  onChooseTarget: (target: DiffTarget) => void;
  onRefresh: () => void;
  view: DiffViewPrefs;
  onSetView: <K extends keyof DiffViewPrefs>(key: K, value: DiffViewPrefs[K]) => void;
  /** Word wrap and line numbers are plugin settings, shared with the Files tab. */
  prefs: EditorPrefs;
  onSetPref: SetPref;
  /** The layout in use, which is unified while the pane is too narrow for two columns. */
  layout: DiffLayout;
  /** The open prompt for the one value a comparison still needs. Controlled, so a failed list can ask for a branch. */
  prompt: ScopePrompt | null;
  onPrompt: (prompt: ScopePrompt | null) => void;
}

export interface ScopePrompt {
  kind: "commit" | "branch";
  /** The comparison the answer applies to. */
  scope: DiffScope;
}

/** A comparison the user can pick, in the order the menu lists them. */
const SCOPE_ORDER: readonly Exclude<DiffScope, "commit">[] = ["uncommitted", "all", "branch_committed"];

export function ScopeBar({
  threadId,
  target,
  baseBranch,
  summary,
  isLoading,
  onChooseTarget,
  onRefresh,
  view,
  onSetView,
  prefs,
  onSetPref,
  layout,
  prompt,
  onPrompt,
}: ScopeBarProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [commits, setCommits] = useState<{ sha: string; subject: string }[]>([]);
  const [commitStatus, setCommitStatus] = useState<"loading" | "ready" | "error">("loading");
  const [commitMessage, setCommitMessage] = useState<string | null>(null);
  const rpc = useRpc<typeof rpcContract>();
  const request = useRef(0);
  const commitBase = comparisonBranch(target, baseBranch) ?? baseBranch;
  useEffect(() => {
    request.current += 1;
    setCommits([]);
    setExpanded(false);
    setScopeOpen(false);
    return () => { request.current += 1; };
  }, [threadId, commitBase]);
  const loadCommits = () => {
    const generation = ++request.current;
    setCommitStatus("loading");
    setCommitMessage(null);
    void rpc.call("diffCommits", { threadId, target }).then((result) => {
      if (generation !== request.current) return;
      setCommits(result.commits);
      setCommitMessage(result.message);
      setCommitStatus("ready");
    }).catch((error: unknown) => {
      if (generation !== request.current) return;
      setCommitStatus("error");
      setCommitMessage(error instanceof Error ? error.message : "Could not load commits");
    });
  };
  const wording = describeTarget(target, baseBranch);
  const activeCommit = target.type === "commit" ? commits.find((commit) => commit.sha.startsWith(target.sha)) : null;
  const scopeIcon = (scope: DiffScope) => scope === "uncommitted" ? <FileAddGlyph /> : scope === "all" ? <CompareGlyph /> : <CommitGlyph />;

  const chooseScope = (scope: DiffScope) => {
    if (scope === "commit") {
      onPrompt({ kind: "commit", scope });
      return;
    }
    if (scope === "uncommitted") {
      onChooseTarget({ type: "uncommitted" });
      return;
    }
    if (commitBase === null) {
      onPrompt({ kind: "branch", scope });
      return;
    }
    onChooseTarget({ type: scope, mergeBaseBranch: commitBase });
  };

  const scopeItems: ScopeMenuItem[] = [
    ...SCOPE_ORDER.map((scope): ScopeMenuItem => {
      const wordingFor = describeTarget({ type: scope }, commitBase);
      return {
        type: "radio", label: wordingFor.label, title: wordingFor.detail,
        icon: scopeIcon(scope), checked: target.type === scope,
        onToggle: () => chooseScope(scope),
      };
    }),
    { type: "separator" },
    { type: "label", label: commitBase ? `Commits · compared with ${commitBase}` : "Commits" },
    ...(commitStatus === "loading" ? [{ label: "Loading commits…", disabled: true, onSelect: () => {} } satisfies ScopeMenuItem]
      : commitStatus === "error" ? [{ label: "Retry loading commits", title: commitMessage ?? undefined, onSelect: loadCommits, keepOpen: true } satisfies ScopeMenuItem]
      : [
        ...commits.slice(0, expanded ? undefined : 10).map((commit): ScopeMenuItem => ({
          type: "radio", id: commit.sha, icon: <CommitGlyph />,
          label: commit.subject || "Untitled commit", shortcut: shortSha(commit.sha),
          title: `${commit.subject}\n${commit.sha}`,
          checked: target.type === "commit" && commit.sha.startsWith(target.sha),
          onToggle: () => onChooseTarget({ type: "commit", sha: commit.sha }),
        })),
        ...(commits.length === 0 ? [{ type: "label", label: commitMessage ?? "No commits on this branch" } satisfies ScopeMenuItem] : []),
        ...(commits.length > 0 && commitMessage ? [{ type: "label", label: commitMessage } satisfies ScopeMenuItem] : []),
      ]),
    { type: "separator" },
    { label: "Find commit…", icon: <BranchGlyph />, onSelect: () => chooseScope("commit") },
    ...(commitStatus === "ready" && commits.length > 10 ? [{
      id: "expand-commits", label: expanded ? "Show less" : `Show more (${commits.length - 10})`,
      icon: <ChevronIcon open={!expanded} />, keepOpen: true,
      onSelect: () => setExpanded((value) => !value),
    } satisfies ScopeMenuItem] : []),
  ];

  const viewItems: MenuItem[] = [
    { type: "toggle", label: "Side by side", checked: view.layout === "split", onToggle: (next) => onSetView("layout", next ? "split" : "unified") },
    ...(view.layout === "split" && layout === "unified"
      ? [{ label: "Side by side needs a wider panel", disabled: true, onSelect: () => {} } satisfies MenuItem]
      : []),
    { type: "toggle", label: "Wrap long lines", checked: prefs.wordWrap, onToggle: (next) => onSetPref("wordWrap", next) },
    { type: "toggle", label: "Line numbers", checked: prefs.lineNumbers, onToggle: (next) => onSetPref("lineNumbers", next) },
    { type: "toggle", label: "Show unchanged lines", checked: view.expandUnchanged, onToggle: (next) => onSetView("expandUnchanged", next) },
  ];

  return (
    <>
      <div className={ROW_CLASS}>
        <DiffScopeMenu items={scopeItems} open={scopeOpen} onOpenChange={(open) => {
          setScopeOpen(open);
          if (open) { setExpanded(false); loadCommits(); }
        }}>
        <button
          type="button"
          title={wording.detail}
          className={cn(
            "flex min-w-0 shrink cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-foreground",
            "hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          {scopeIcon(target.type)}
          <span className="truncate">{activeCommit?.subject || wording.label}</span>
          <ChevronIcon open className="text-muted-foreground" />
        </button>
        </DiffScopeMenu>
        <Summary summary={summary} isLoading={isLoading} />
        <ToolbarButton label="Refresh" onClick={onRefresh}>
          <RefreshGlyph className={cn(isLoading && "animate-spin")} />
        </ToolbarButton>
        <ToolbarButton label="View options" onClick={(event) => setMenu(menuAt(event.currentTarget, viewItems))}>
          <MoreIcon />
        </ToolbarButton>
      </div>
      {prompt === null ? null : (
        <ValuePrompt
          key={`${prompt.kind}:${prompt.scope}`}
          kind={prompt.kind}
          suggestion={prompt.kind === "branch" ? (comparisonBranch(target, baseBranch) ?? "") : ""}
          onCancel={() => onPrompt(null)}
          onSubmit={(value) => {
            onPrompt(null);
            if (prompt.kind === "commit") onChooseTarget({ type: "commit", sha: value });
            else if (prompt.scope === "all" || prompt.scope === "branch_committed") {
              onChooseTarget({ type: prompt.scope, mergeBaseBranch: value });
            }
          }}
        />
      )}
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </>
  );
}

function Summary({ summary, isLoading }: { summary: ChangeSummary | null; isLoading: boolean }) {
  if (summary === null) {
    return <span className="flex-1" />;
  }
  const files = summary.files === 1 ? "1 file" : `${summary.files} files`;
  return (
    <span
      role="status"
      className={cn("flex min-w-0 flex-1 items-center gap-1.5 pl-1 text-xs text-muted-foreground", isLoading && "opacity-60")}
    >
      <span className="truncate">{files}</span>
      {summary.additions > 0 ? <span className="shrink-0 text-success-foreground">+{summary.additions}</span> : null}
      {summary.deletions > 0 ? <span className="shrink-0 text-destructive">&minus;{summary.deletions}</span> : null}
    </span>
  );
}

/** One short input, shown in place, for the value a comparison still needs. */
function ValuePrompt({
  kind,
  suggestion,
  onSubmit,
  onCancel,
}: {
  kind: "commit" | "branch";
  suggestion: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(suggestion);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const trimmed = value.trim();
  const valid = kind === "commit" ? isCommitHash(trimmed) : isBranchRef(trimmed);
  return (
    <form
      className="flex shrink-0 items-center gap-1.5 border-b border-border/60 bg-surface-recessed px-2 py-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSubmit(trimmed);
      }}
    >
      <label className="shrink-0 text-xs text-muted-foreground" htmlFor={`diff-prompt-${kind}`}>
        {kind === "commit" ? "Commit" : "Compare with"}
      </label>
      <input
        id={`diff-prompt-${kind}`}
        ref={inputRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
        placeholder={kind === "commit" ? "Commit hash" : "Branch name"}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className={cn(
          "min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground",
          "placeholder:text-subtle-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        )}
      />
      <button
        type="submit"
        disabled={!valid}
        className={cn(
          "shrink-0 cursor-pointer rounded-md border border-border px-2 py-1 text-xs text-foreground",
          "hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          "disabled:pointer-events-none disabled:opacity-40",
        )}
      >
        Compare
      </button>
      <ToolbarButton label="Cancel" onClick={onCancel}>
        <CloseIcon />
      </ToolbarButton>
    </form>
  );
}

export type DiffSaveIndicator = "clean" | "dirty" | "saving" | "error";

export interface FileBarProps {
  entry: DiffEntry | null;
  path: string;
  indicator: DiffSaveIndicator;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onOpenFile: (() => void) | null;
  menuItems: MenuItem[];
  listOpen: boolean;
  listSide: "left" | "right";
  onToggleList: () => void;
}

/** The row above the comparison: file navigation, the file, and its actions. */
export function FileBar({
  entry,
  path,
  indicator,
  canPrevious,
  canNext,
  onPrevious,
  onNext,
  onOpenFile,
  menuItems,
  listOpen,
  listSide,
  onToggleList,
}: FileBarProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const ListGlyph = listSide === "right" ? SidebarRightGlyph : SidebarLeftGlyph;
  return (
    <div className={ROW_CLASS}>
      <ToolbarButton label="Previous file" onClick={onPrevious} disabled={!canPrevious}>
        <ArrowLeftIcon />
      </ToolbarButton>
      <ToolbarButton label="Next file" onClick={onNext} disabled={!canNext}>
        <ArrowRightIcon />
      </ToolbarButton>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-1.5">
        <FileIcon path={path} className="text-muted-foreground" />
        <FilePath path={path} previousPath={entry?.previousPath ?? null} />
        <SaveDot indicator={indicator} />
      </div>
      <ToolbarButton label="File actions" onClick={(event) => setMenu(menuAt(event.currentTarget, menuItems))} pressed={menu !== null}>
        <MoreIcon />
      </ToolbarButton>
      {onOpenFile === null ? null : (
        <ToolbarButton label="Open this file" onClick={onOpenFile}>
          <ExternalIcon />
        </ToolbarButton>
      )}
      <ToolbarButton label={listOpen ? "Hide the change list" : "Show the change list"} onClick={onToggleList} pressed={listOpen}>
        <ListGlyph />
      </ToolbarButton>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

/** The file name, with the name it had before a rename. */
function FilePath({ path, previousPath }: { path: string; previousPath: string | null }) {
  const name = path.split("/").at(-1) ?? path;
  const directory = path.slice(0, path.length - name.length).replace(/\/$/, "");
  const title = previousPath === null ? path : `${previousPath} → ${path}`;
  return (
    <span title={title} className="flex min-w-0 items-baseline gap-1 font-mono text-xs leading-5">
      {directory === "" ? null : <span className="min-w-0 shrink truncate text-muted-foreground">{directory}/</span>}
      <span className="shrink-0 font-medium text-foreground">{name}</span>
    </span>
  );
}

function SaveDot({ indicator }: { indicator: DiffSaveIndicator }) {
  if (indicator === "clean") return null;
  const label =
    indicator === "saving" ? "Saving…" : indicator === "error" ? "This file could not be read or saved" : "Unsaved changes (⌘S to save)";
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center" title={label} role="status" aria-label={label}>
      <span
        className={cn(
          "size-2 rounded-full transition-colors",
          indicator === "saving" && "animate-pulse bg-foreground",
          indicator === "dirty" && "bg-foreground",
          indicator === "error" && "bg-destructive",
        )}
      />
    </span>
  );
}

export { needsBranch };
