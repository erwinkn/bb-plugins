import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown, useRpc, type PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { hasMarkdownImage, rewriteMarkdownPaths, workspacePathFromHref } from "@/lib/markdown-preview";

/** Renew a lease this long before it expires, so an image never loads from a dead one. */
const LEASE_RENEWAL_MARGIN_MS = 60_000;

interface Lease {
  baseUrl: string;
  expiresAtMs: number;
}

export interface MarkdownPreviewProps {
  source: PluginFileOpenerSource;
  path: string;
  /** The document's path relative to `rootPath`, the workspace root the lease serves. */
  relativePath: string;
  rootPath: string;
  content: string;
  /** Opens another file of the workspace in this view; null when the view cannot navigate. */
  onOpenPath: ((path: string) => void) | null;
}

/**
 * A Markdown document rendered in BB's chat typography. Relative images load
 * through a temporary preview lease for the workspace root, requested only
 * when the document has one and renewed before it lapses. Relative links are
 * resolved from the document's directory; BB renders them as file links, and
 * a plain click on one opens that file here.
 */
export function MarkdownPreview({ source, path, relativePath, rootPath, content, onOpenPath }: MarkdownPreviewProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [lease, setLease] = useState<Lease | null>(null);
  const needsLease = hasMarkdownImage(content);

  useEffect(() => {
    if (!needsLease) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const renew = () => {
      rpc
        .call("previewBase", { path, source })
        .then((next) => {
          if (cancelled) return;
          setLease(next);
          timer = setTimeout(renew, Math.max(0, next.expiresAtMs - Date.now() - LEASE_RENEWAL_MARGIN_MS));
        })
        .catch((error: unknown) => {
          // Without a lease the text still renders; only relative images are missing.
          console.warn("[erwin-editor] could not lease the preview root", error);
        });
    };
    renew();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [needsLease, path, rpc, source]);

  const rendered = useMemo(
    () => rewriteMarkdownPaths(content, { filePath: relativePath, baseUrl: lease?.baseUrl ?? null }),
    [content, lease, relativePath],
  );

  // BB renders the links itself and opens a file link in a new tab. A plain
  // click on a file under the root opens it here instead. The listener is
  // native and in the capture phase, so it runs before the host's handler.
  const container = useRef<HTMLDivElement | null>(null);
  const openPath = useRef(onOpenPath);
  openPath.current = onOpenPath;
  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const intercept = (event: MouseEvent) => {
      const open = openPath.current;
      if (open === null || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      if (anchor === null) return;
      const target = workspacePathFromHref(anchor.getAttribute("href") ?? "", rootPath);
      if (target === null) return;
      event.preventDefault();
      event.stopPropagation();
      open(target);
    };
    element.addEventListener("click", intercept, true);
    return () => element.removeEventListener("click", intercept, true);
  }, [rootPath]);

  return (
    <div ref={container} className="absolute inset-0 overflow-auto bg-background" data-testid="markdown-preview">
      <Markdown content={rendered} className="mx-auto max-w-3xl px-6 py-5" />
    </div>
  );
}
