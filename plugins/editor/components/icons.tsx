/**
 * Icons come from BB's host registry where it has a name for them (see
 * lib/host-icon.tsx), at BB's compact size: 14px via `size-3.5`,
 * `text-muted-foreground` unless a parent sets the color. Glyphs the
 * registry has no name for still come from Hugeicons, the set BB draws its
 * own chrome with, at stroke 1.5.
 */
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  GitCommitIcon,
  GitCompareIcon,
  FileAddIcon,
} from "@hugeicons/core-free-icons";
import { fileGlyph } from "@/lib/file-icons";
import { HostIcon } from "@/lib/host-icon";
import type { HostIconName } from "@/lib/host-icon-names";
import { cn } from "@/lib/utils";

interface IconProps {
  className?: string;
}

function makeHost(name: HostIconName) {
  return function Icon({ className }: IconProps) {
    return <HostIcon name={name} className={cn("size-3.5 shrink-0", className)} />;
  };
}

function make(icon: IconSvgElement) {
  return function Icon({ className }: IconProps) {
    return <HugeiconsIcon icon={icon} strokeWidth={1.5} className={cn("size-3.5 shrink-0", className)} aria-hidden />;
  };
}

export const BranchGlyph = makeHost("GitBranch");
export const CommitGlyph = make(GitCommitIcon);
export const CompareGlyph = make(GitCompareIcon);

export const ArrowLeftIcon = make(ArrowLeft01Icon);
export const ArrowRightIcon = makeHost("ArrowRight");
export const CloseIcon = makeHost("X");
export const CheckIcon = makeHost("Check");
export const ExternalIcon = makeHost("ExternalLink");
export const FileAddGlyph = make(FileAddIcon);
export const FolderAddGlyph = makeHost("FolderPlus");
export const FolderIcon = makeHost("Folder");
export const FolderOpenGlyph = makeHost("FolderOpen");
export const MoreIcon = makeHost("MoreHorizontal");
export const EditGlyph = makeHost("Edit");
export const PreviewGlyph = makeHost("Eye");
export const RefreshGlyph = makeHost("ArrowReloadHorizontal");
export const RevertGlyph = makeHost("ArrowTurnBackward");
export const SearchIcon = makeHost("Search");
export const SidebarLeftGlyph = makeHost("PanelLeft");
export const SidebarRightGlyph = makeHost("PanelRight");

export function ChevronIcon({ className, open }: IconProps & { open: boolean }) {
  return (
    <HostIcon
      name="ChevronRight"
      className={cn("size-3.5 shrink-0 transition-transform duration-100", open && "rotate-90", className)}
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

const GenericFileIcon = makeHost("File");
