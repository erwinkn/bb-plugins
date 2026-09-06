import { cn } from "@/lib/utils";

interface IconProps {
  className?: string;
}

function Svg({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-3.5 shrink-0", className)}
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const PanelLeftIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M9 3v18" />
  </Svg>
);
export const PanelLeftOpenIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M9 3v18M14 9l3 3-3 3" />
  </Svg>
);
export const PanelLeftCloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M9 3v18M16 15l-3-3 3-3" />
  </Svg>
);
export const RotateIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 2v6h6M3.51 15a9 9 0 102.13-9.36L3 8" />
  </Svg>
);
export const ExternalIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 3h6v6M10 14L21 3M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
  </Svg>
);
export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 6L6 18M6 6l12 12" />
  </Svg>
);
export const ChevronIcon = ({ className, open }: IconProps & { open: boolean }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={cn("size-3 shrink-0 transition-transform duration-100", open && "rotate-90", className)}
    aria-hidden
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);
export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </Svg>
);
export const FolderIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20h16a2 2 0 002-2V8a2 2 0 00-2-2h-7.9a2 2 0 01-1.69-.9L9.6 3.9A2 2 0 007.93 3H4a2 2 0 00-2 2v13a2 2 0 002 2z" />
  </Svg>
);
export const CodeFileIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 6L2 12l6 6M16 6l6 6-6 6" />
  </Svg>
);
export const DataFileIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3H7a2 2 0 00-2 2v4a2 2 0 01-2 2 2 2 0 012 2v4a2 2 0 002 2h1M16 3h1a2 2 0 012 2v4a2 2 0 002 2 2 2 0 00-2 2v4a2 2 0 01-2 2h-1" />
  </Svg>
);
export const DocFileIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" />
    <path d="M14 2v6h6M8 13h8M8 17h6" />
  </Svg>
);
export const ImageFileIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="M21 15l-3.1-3.1a2 2 0 00-2.8 0L6 21" />
  </Svg>
);
export const LockFileIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect width="18" height="11" x="3" y="11" rx="2" />
    <path d="M7 11V7a5 5 0 0110 0v4" />
  </Svg>
);
export const ShellFileIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 17l6-6-6-6M12 19h8" />
  </Svg>
);
export const GenericFileIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" />
    <path d="M14 2v6h6" />
  </Svg>
);

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
