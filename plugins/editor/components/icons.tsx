/**
 * Icons come from Hugeicons, the set BB draws its own chrome with, at BB's
 * compact size: 14px, stroke 1.5, `text-muted-foreground` unless a parent
 * sets the color.
 */
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowTurnBackwardIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitCompareIcon,
  Cancel01Icon,
  File01Icon,
  FileAddIcon,
  Folder01Icon,
  FolderAddIcon,
  FolderOpenIcon,
  LinkSquare01Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  RefreshIcon,
  Search01Icon,
  SidebarLeftIcon,
  SidebarRightIcon,
  ViewIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { fileGlyph } from "@/lib/file-icons";
import { cn } from "@/lib/utils";

interface IconProps {
  className?: string;
}

function make(icon: IconSvgElement) {
  return function Icon({ className }: IconProps) {
    return <HugeiconsIcon icon={icon} strokeWidth={1.5} className={cn("size-3.5 shrink-0", className)} aria-hidden />;
  };
}

export const BranchGlyph = make(GitBranchIcon);
export const CommitGlyph = make(GitCommitIcon);
export const CompareGlyph = make(GitCompareIcon);

export const ArrowLeftIcon = make(ArrowLeft01Icon);
export const ArrowRightIcon = make(ArrowRight01Icon);
export const CloseIcon = make(Cancel01Icon);
export const CheckIcon = make(Tick02Icon);
export const ExternalIcon = make(LinkSquare01Icon);
export const FileAddGlyph = make(FileAddIcon);
export const FolderAddGlyph = make(FolderAddIcon);
export const FolderIcon = make(Folder01Icon);
export const FolderOpenGlyph = make(FolderOpenIcon);
export const MoreIcon = make(MoreHorizontalIcon);
export const EditGlyph = make(PencilEdit02Icon);
export const PreviewGlyph = make(ViewIcon);
export const RefreshGlyph = make(RefreshIcon);
export const RevertGlyph = make(ArrowTurnBackwardIcon);
export const SearchIcon = make(Search01Icon);
export const SidebarLeftGlyph = make(SidebarLeftIcon);
export const SidebarRightGlyph = make(SidebarRightIcon);

export function ChevronIcon({ className, open }: IconProps & { open: boolean }) {
  return (
    <HugeiconsIcon
      icon={ArrowRight01Icon}
      strokeWidth={1.5}
      className={cn("size-3.5 shrink-0 transition-transform duration-100", open && "rotate-90", className)}
      aria-hidden
    />
  );
}

/**
 * A file's icon from the `@pierre/trees` set, coloured the way BB's own file
 * trees colour it. Files the set does not know get its plain document icon.
 */
export function FileIcon({ path, className }: { path: string; className?: string }) {
  const glyph = fileGlyph(path);
  if (glyph === null) return <GenericFileIcon className={className} />;
  return (
    <svg
      viewBox={glyph.viewBox}
      className={cn("size-3.5 shrink-0", className)}
      style={glyph.color === null ? undefined : { color: glyph.color }}
      data-file-icon={glyph.token}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: glyph.body }}
    />
  );
}

const GenericFileIcon = make(File01Icon);
