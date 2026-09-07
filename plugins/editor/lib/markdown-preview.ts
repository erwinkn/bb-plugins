/**
 * Relative paths in a Markdown document, for its rendered preview. The
 * document's own directory is where they resolve, and they must stay inside
 * the workspace root. Images are pointed at a preview lease, which serves the
 * files under that root. Links to other files become root-relative, which is
 * how BB's Markdown renderer reads a path; the preview then opens them.
 */

const INLINE = /(!?)\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)((?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*)\)/g;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

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
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(href).pathname);
  } catch {
    return null;
  }
  const root = rootPath.replace(/\/+$/, "");
  if (root === "") return null;
  return pathname.startsWith(`${root}/`) && pathname.length > root.length + 1 ? pathname.slice(root.length + 1) : null;
}

/** The workspace root a file was read from: its absolute path minus its root-relative one. */
export function workspaceRoot(absolutePath: string, relativePath: string): string {
  if (relativePath === "" || !absolutePath.endsWith(relativePath)) return "";
  return absolutePath.slice(0, absolutePath.length - relativePath.length).replace(/[\\/]+$/, "");
}
