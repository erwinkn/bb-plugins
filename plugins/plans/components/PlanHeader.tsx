import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { cn } from "@/lib/utils";
import type { Plan, PlanVersion } from "../contract";
import { latestVersion, sortedVersions } from "../lib/plan-model";
import { compactRelativeTime, formatDateTime, formatRelativeTime } from "../lib/time";


export type ReviewView = "document" | "changes" | "comments";

interface PlanHeaderProps {
  plan: Plan;
  version: PlanVersion;
  onVersionChange: (versionId: string) => void;
  view: ReviewView;
  onViewChange: (view: ReviewView) => void;
  /** Comments is offered only when the rail is not beside the document. */
  showCommentsTab: boolean;
  commentCount: number;
  onBack?: () => void;
  onRevise: () => void;
  onDelete: () => void;
}

export function PlanHeader({
  plan,
  version,
  onVersionChange,
  view,
  onViewChange,
  showCommentsTab,
  commentCount,
  onBack,
  onRevise,
  onDelete,
}: PlanHeaderProps) {
  const versions = sortedVersions(plan);
  const latest = latestVersion(plan);
  const views: { value: ReviewView; label: string; count?: number }[] = [
    { value: "document", label: "Document" },
    { value: "changes", label: "Changes" },
    ...(showCommentsTab ? [{ value: "comments" as const, label: "Comments", count: commentCount }] : []),
  ];

  const updatedCompact = compactRelativeTime(plan.updatedAt);
  const updatedFull = `Updated ${formatDateTime(plan.updatedAt)}`;

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(version.markdown);
      toast.success(`Copied v${version.number} as Markdown`);
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  };

  return (
    <header className="shrink-0 border-b border-border bg-background">
      {/* Title, view and version pickers, and the actions menu. Status,
          project, and thread identity are already known inside the thread. */}
      <div className="flex items-center gap-2 px-4 py-3">
        {onBack ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Back to plans"
            onClick={onBack}
            className={cn(COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS, "-ml-1 shrink-0")}
          >
            <Icon name="ChevronLeft" aria-hidden />
          </Button>
        ) : null}
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h1 className="min-w-0 truncate text-base font-semibold leading-6 text-foreground">{plan.title}</h1>
          <time
            dateTime={new Date(plan.updatedAt).toISOString()}
            title={updatedFull}
            aria-label={updatedFull}
            className="shrink-0 text-xs tabular-nums text-muted-foreground"
          >
            {updatedCompact}
          </time>
        </div>
        <Select value={view} onValueChange={(value) => onViewChange(value as ReviewView)}>
          <SelectTrigger
            aria-label={`Plan view: ${views.find((item) => item.value === view)?.label}`}
            title="Switch view"
            className="h-8 w-auto min-w-0 shrink-0 gap-1 border-transparent bg-transparent px-1.5 text-muted-foreground hover:text-foreground"
          >
            <SelectValue><Icon name={view === "document" ? "ListTodo" : view === "changes" ? "Code" : "MessageSquare"} className="size-4" aria-hidden /></SelectValue>
          </SelectTrigger>
          <SelectContent align="end">
            {views.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}{item.count ? ` (${item.count})` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={version.id} onValueChange={onVersionChange}>
          <SelectTrigger
            aria-label="Plan version"
            className="h-7 w-auto min-w-0 shrink-0 gap-0.5 rounded-md border-transparent bg-transparent px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground focus:ring-1 focus:ring-ring"
          >
            <SelectValue>v{version.number}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end">
            {versions.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                v{candidate.number}
                {latest && latest.id === candidate.id ? " · latest" : ""}
                <span className="ml-2 text-muted-foreground">{formatRelativeTime(candidate.createdAt)}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Plan actions"
              className={cn(COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS, "-mr-1 shrink-0")}
            >
              <Icon name="MoreHorizontal" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onRevise}>
              <Icon name="Plus" className="size-4" aria-hidden />
              {plan.sample ? "Add revision" : "Import revision"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copyMarkdown()}>
              <Icon name="Copy" className="size-4" aria-hidden />
              Copy Markdown
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive">
              <Icon name="Trash2" className="size-4" aria-hidden />
              Delete plan
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

    </header>
  );
}
