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
  BracesIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitCompareIcon,
  Cancel01Icon,
  ComputerTerminal01Icon,
  File01Icon,
  FileAddIcon,
  Folder01Icon,
  FolderAddIcon,
  FolderOpenIcon,
  Image01Icon,
  LinkSquare01Icon,
  LockIcon,
  MoreHorizontalIcon,
  RefreshIcon,
  Search01Icon,
  SidebarLeftIcon,
  SidebarRightIcon,
  SourceCodeIcon,
  TextAlignLeft01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
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
export const RefreshGlyph = make(RefreshIcon);
export const RevertGlyph = make(ArrowTurnBackwardIcon);
export const SearchIcon = make(Search01Icon);
export const SidebarLeftGlyph = make(SidebarLeftIcon);
export const SidebarRightGlyph = make(SidebarRightIcon);

const CodeFileIcon = make(SourceCodeIcon);
const DataFileIcon = make(BracesIcon);
const DocFileIcon = make(TextAlignLeft01Icon);
const ImageFileIcon = make(Image01Icon);
const LockFileIcon = make(LockIcon);
const ShellFileIcon = make(ComputerTerminal01Icon);
const GenericFileIcon = make(File01Icon);

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

const DATA = new Set(["json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml", "csv", "tsv", "env", "plist", "properties", "lock"]);
const DOC = new Set(["md", "mdx", "markdown", "txt", "text", "rst", "adoc", "log", "tex", "bib"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif", "heic"]);
const SHELL = new Set(["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"]);

export type FileKind = "code" | "data" | "doc" | "image" | "lock" | "shell" | "generic";

export function fileKind(path: string): FileKind {
  const name = path.split(/[\\/]/).at(-1) ?? path;
  const lower = name.toLowerCase();
  if (lower.endsWith(".lock") || lower === "package-lock.json" || lower === "yarn.lock" || lower === "pnpm-lock.yaml") return "lock";
  if (lower.startsWith(".env")) return "data";
  const dotIndex = lower.lastIndexOf(".");
  const extension = dotIndex <= 0 ? "" : lower.slice(dotIndex + 1);
  if (extension === "") {
    if (/^(dockerfile|makefile|containerfile|justfile|procfile)$/i.test(lower)) return "code";
    if (/^(license|licence|readme|changelog|codeowners|authors|notice)$/i.test(lower)) return "doc";
    return "generic";
  }
  if (DATA.has(extension)) return "data";
  if (DOC.has(extension)) return "doc";
  if (IMAGE.has(extension)) return "image";
  if (SHELL.has(extension)) return "shell";
  return "code";
}

export function FileIcon({ path, className }: { path: string; className?: string }) {
  switch (fileKind(path)) {
    case "data":
      return <DataFileIcon className={className} />;
    case "doc":
      return <DocFileIcon className={className} />;
    case "image":
      return <ImageFileIcon className={className} />;
    case "lock":
      return <LockFileIcon className={className} />;
    case "shell":
      return <ShellFileIcon className={className} />;
    case "code":
      return <CodeFileIcon className={className} />;
    default:
      return <GenericFileIcon className={className} />;
  }
}
