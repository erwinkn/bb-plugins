/**
 * The document binding behind a rendered Markdown preview, and the relative
 * paths for a preview BB cannot bind (see MarkdownPreview). A source BB can
 * bind — a thread's workspace or its storage — renders through
 * `documentFor`, and BB resolves relative images and links itself. For any
 * other source the document's own directory is where relative paths
 * resolve, and they must stay inside the workspace root. Images are pointed
 * at a preview lease, which serves the files under that root. Links to
 * other files become root-relative, which is how BB's Markdown renderer
 * reads a path; the preview then opens them.
 */
import type { ExperimentalLiveFileTarget } from "@get-bb/plugin-sdk/app";
import type { FileSessionSource } from "./file-session";

const INLINE = /(!?)\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)((?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*)\)/g;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/** A link definition line; `[^` labels are footnotes, which have no path to rewrite. */
const DEFINITION = /^(\s{0,3}\[(?!\^)[^\]]*\]:\s*)(<[^>]*>|[^)\s]+)(.*)$/;

/** BB's document binding for a source it can serve: a thread's environment or its storage. */
export interface MarkdownPreviewDocument {
  threadId: string;
  rootPath: string;
  target: Exclude<ExperimentalLiveFileTarget, { kind: "host" }>;
}

/**
 * The document binding for `source`, or null when BB cannot bind it — a
 * host path, or a workspace with no thread — and the preview rewrites
 * relative paths instead.
 */
export function documentFor(source: FileSessionSource, rootPath: string, relativePath: string): MarkdownPreviewDocument | null {
  if (source.threadId === null || rootPath === "" || relativePath === "") return null;
  if (source.kind === "workspace" && source.environmentId !== null) {
    return { threadId: source.threadId, rootPath, target: { kind: "workspace", environmentId: source.environmentId, path: relativePath } };
  }
  if (source.kind === "thread-storage") {
    return { threadId: source.threadId, rootPath, target: { kind: "thread-storage", threadId: source.threadId, path: relativePath } };
  }
  return null;
}

export interface PathRewrite {
  /** The document's path, relative to the workspace root. */
  filePath: string;
  /** The lease's URL base, without a trailing slash; null leaves images as written. */
  baseUrl: string | null;
}

/** Whether the document has an image that a rewrite could point at the lease. */
export function hasMarkdownImage(markdown: string): boolean {
  return /!\[/.test(markdown);
}

export function rewriteMarkdownPaths(markdown: string, { filePath, baseUrl }: PathRewrite): string {
  const directory = filePath.split(/[\\/]/).slice(0, -1);
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const opening = FENCE.exec(line);
      if (opening !== null) {
        const marker = opening[1]!;
        if (fence === null) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return line;
      }
      if (fence !== null) return line;
      const definition = DEFINITION.exec(line);
      if (definition !== null) {
        const [, prefix, rawTarget, rest] = definition;
        const target = rawTarget.startsWith("<") ? rawTarget.slice(1, -1) : rawTarget;
        const resolved = resolveRelative(directory, target);
        if (resolved === null) return line;
        const link = resolved.join("/");
        return `${prefix}${/[\s()]/.test(link) ? `<${link}>` : link}${rest}`;
      }
      return line.replace(INLINE, (whole, bang: string, text: string, rawTarget: string, title: string) => {
        const image = bang === "!";
        if (image && baseUrl === null) return whole;
        const target = rawTarget.startsWith("<") ? rawTarget.slice(1, -1) : rawTarget;
        const resolved = resolveRelative(directory, target);
        if (resolved === null) return whole;
        if (image) return `![${text}](${baseUrl}/${resolved.map(encodeURIComponent).join("/")}${title})`;
        const link = resolved.join("/");
        return `[${text}](${/[\s()]/.test(link) ? `<${link}>` : link}${title})`;
      });
    })
    .join("\n");
}

/** The root-relative segments of `target`, or null when it is not a relative file path. */
function resolveRelative(directory: readonly string[], target: string): string[] | null {
  if (target === "" || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("/") || target.startsWith("#")) return null;
  if (target.startsWith("//")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.replace(/[?#].*$/, ""));
  } catch {
    return null;
  }
  const segments = [...directory];
  for (const part of decoded.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.length === 0 ? null : segments;
}

/**
 * The root-relative path of a `file:` link BB rendered for a document under
 * `rootPath`, or null for any other link.
 */
export function workspacePathFromHref(href: string, rootPath: string): string | null {
  if (!href.startsWith("file:")) return null;
  let url: URL;
  let pathname: string;
  try {
    url = new URL(href);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const windows = /^[a-z]:[\\/]/i.test(rootPath) || rootPath.startsWith("\\\\") || rootPath.startsWith("//");
  const root = (windows ? rootPath.replace(/\\/g, "/") : rootPath).replace(/\/+$/, "");
  if (root === "") return null;
  if (windows) {
    pathname = url.hostname ? `//${url.hostname}${pathname}` : pathname.replace(/^\/(?=[a-z]:\/)/i, "");
  } else if (url.hostname) {
    return null;
  }
  const candidate = windows ? pathname.toLowerCase() : pathname;
  const prefix = windows ? root.toLowerCase() : root;
  return candidate.startsWith(`${prefix}/`) && pathname.length > root.length + 1 ? pathname.slice(root.length + 1) : null;
}

/**
 * The root-relative path a rewritten link refers to — a bare relative path
 * under the workspace root — or null for anything the rewrite leaves alone:
 * schemes, anchors, absolute paths, `..` escapes.
 */
export function rootRelativeFromHref(href: string): string | null {
  if (href === "" || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith("/") || href.startsWith("#") || href.startsWith("?")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.replace(/[?#].*$/, ""));
  } catch {
    decoded = href.replace(/[?#].*$/, "");
  }
  if (decoded === "" || decoded.split("/").some((part) => part === "..")) return null;
  return decoded;
}

/** The workspace root a file was read from: its absolute path minus its root-relative one. */
export function workspaceRoot(absolutePath: string, relativePath: string): string {
  if (/^[a-z]:[\\/]/i.test(absolutePath) || absolutePath.startsWith("\\\\")) {
    absolutePath = absolutePath.replace(/\\/g, "/");
    relativePath = relativePath.replace(/\\/g, "/");
  }
  if (relativePath === "" || !absolutePath.endsWith(relativePath)) return "";
  return absolutePath.slice(0, absolutePath.length - relativePath.length).replace(/[\\/]+$/, "");
}

/**
 * The heading slug an anchor refers to: the heading text in lower case,
 * punctuation dropped, spaces as hyphens. BB's renderer gives headings no
 * ids, so the preview matches anchors by text.
 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/** The slug an anchor href names, or null when the href is not a same-document anchor. */
export function anchorSlug(href: string): string | null {
  if (!href.startsWith("#") || href.length < 2) return null;
  try {
    return decodeURIComponent(href.slice(1)).toLowerCase();
  } catch {
    return href.slice(1).toLowerCase();
  }
}
