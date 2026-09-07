import { parsePatch } from "diff";
import { useMemo, useState } from "react";
import { experimental_Diff as Diff } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { Plan, PlanVersion } from "../contract";
import { createVersionPatch, PLAN_DIFF_PATH } from "../lib/patch";
import { previousVersion, sortedVersions } from "../lib/plan-model";
import { EmptyState } from "./EmptyState";

interface PlanChangesProps {
  plan: Plan;
  /** The version whose changes are shown (the "after" side). */
  version: PlanVersion;
  isWide: boolean;
  className?: string;
}

/** Compares the displayed version with an earlier one through BB's diff viewer. */
export function PlanChanges({ plan, version, isWide, className }: PlanChangesProps) {
  const earlier = useMemo(
    () => sortedVersions(plan).filter((candidate) => candidate.number < version.number),
    [plan, version.number],
  );
  const defaultBase = previousVersion(plan, version);
  const [baseId, setBaseId] = useState<string | null>(null);
  const [view, setView] = useState<"unified" | "split">("unified");
  const base =
    earlier.find((candidate) => candidate.id === baseId) ?? defaultBase ?? null;

  const patch = useMemo(
    () =>
      base === null
        ? null
        : createVersionPatch(
            base.markdown,
            version.markdown,
            `v${base.number}`,
            `v${version.number}`,
          ),
    [base, version],
  );

  const counts = useMemo(() => {
    const lines = patch ? parsePatch(patch).flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines)) : [];
    return { added: lines.filter((line) => line.startsWith("+")).length, removed: lines.filter((line) => line.startsWith("-")).length };
  }, [patch]);

  if (base === null) {
    return (
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto p-4", className)}>
        <EmptyState
          icon="FileDiff"
          title="Nothing to compare yet"
          description="Changes appear once the plan has a second version."
        />
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-xs text-muted-foreground">Compare</span>
        <Select value={base.id} onValueChange={setBaseId}>
          <SelectTrigger aria-label="Base version" className="h-7 w-auto min-w-0 gap-1 border-0 bg-transparent px-0 text-xs shadow-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {earlier.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                v{candidate.number}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">
          with <span className="font-medium text-foreground">v{version.number}</span>
        </span>
        <span role="status" aria-label={`${counts.added} additions, ${counts.removed} deletions`} className="ml-auto inline-flex shrink-0 gap-2 font-mono text-xs tabular-nums">
          <span className="text-success">+{counts.added}</span>
          <span className="text-destructive">−{counts.removed}</span>
        </span>
        {isWide ? (
          <div className="ml-auto flex items-center rounded-md border border-border p-0.5" role="group" aria-label="Diff layout">
            <ToggleChip active={view === "unified"} onClick={() => setView("unified")}>
              Unified
            </ToggleChip>
            <ToggleChip active={view === "split"} onClick={() => setView("split")}>
              Split
            </ToggleChip>
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {patch === null ? (
          <div className="p-4">
            <EmptyState
              title={`v${base.number} and v${version.number} are identical`}
              description="The text did not change between these versions."
            />
          </div>
        ) : (
          <Diff
            patch={patch.slice(patch.indexOf("@@"))}
            path={PLAN_DIFF_PATH}
            view={isWide ? view : "unified"}
            overflow="wrap"
            className="text-sm"
          />
        )}
      </div>
    </div>
  );
}

function ToggleChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-pressed={active}
      onClick={onClick}
      className="h-6 rounded-sm px-2 text-xs"
    >
      {children}
    </Button>
  );
}
