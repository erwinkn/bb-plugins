import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { FileSessionSource } from "@/lib/file-session";
import { anchorSlug, documentFor, hasMarkdownImage, headingSlug, rewriteMarkdownPaths, rootRelativeFromHref, workspacePathFromHref } from "@/lib/markdown-preview";
import { EditorTabBoundary } from "./EditorTabBoundary";

/** Renew a lease this long before it expires, so an image never loads from a dead one. */
const LEASE_RENEWAL_MARGIN_MS = 60_000;

interface Lease {
  baseUrl: string;
  expiresAtMs: number;
}

export interface MarkdownPreviewProps {
  source: FileSessionSource;
  path: string;
  /** The document's path relative to `rootPath`, the workspace root the lease serves. */
  relativePath: string;
  rootPath: string;
  content: string;
  /** Opens another file of the workspace in this view; null when the view cannot navigate. */
  onOpenPath: ((path: string) => void) | null;
}

/**
 * A Markdown document rendered in BB's chat typography. A source BB can bind
 * to a document — a thread's workspace or storage — renders through BB's
 * document binding, which resolves relative images and links from the
 * document's directory, confined to the root, and serves the images itself.
 * A source BB cannot bind (a host path, or a workspace with no thread, such
 * as the New thread Files tab) keeps the older path: relative images load
 * through a temporary preview lease for the workspace root, requested only
 * when the document has one and renewed before it lapses, and relative links
 * are rewritten root-relative so BB renders them as file links. Either way a
 * plain click on a file under the root opens that file here.
 */
export function MarkdownPreview({ source, path, relativePath, rootPath, content, onOpenPath }: MarkdownPreviewProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [lease, setLease] = useState<Lease | null>(null);
  const document = useMemo(() => documentFor(source, rootPath, relativePath), [source, rootPath, relativePath]);
  const needsLease = document === null && hasMarkdownImage(content);

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
          console.warn("[editor] could not lease the preview root", error);
        });
    };
    renew();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [needsLease, path, rpc, source]);

  const rendered = useMemo(
    () => (document !== null ? content : rewriteMarkdownPaths(content, { filePath: relativePath, baseUrl: lease?.baseUrl ?? null })),
    [content, document, lease, relativePath],
  );

  // BB renders the links itself: a file link opens BB's preview panel (or a
  // new tab), and an anchor would open the app root. A plain click on a file
  // under the root opens it here instead, and an anchor scrolls to its
  // heading; BB's headings carry no ids, so the slug is matched by text. The
  // listener is native and in the capture phase, so it runs before the
  // host's React handler on the anchor.
  const container = useRef<HTMLDivElement | null>(null);
  const openPath = useRef(onOpenPath);
  openPath.current = onOpenPath;
  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const intercept = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      if (anchor === null) return;
      const href = anchor.getAttribute("href") ?? "";
      const slug = anchorSlug(href);
      if (slug !== null) {
        event.preventDefault();
        event.stopPropagation();
        const heading = Array.from(element.querySelectorAll("h1, h2, h3, h4, h5, h6")).find(
          (candidate) => headingSlug(candidate.textContent ?? "") === slug,
        );
        heading?.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }
      const open = openPath.current;
      if (open === null) return;
      // A bound document's links arrive as `file:` hrefs; a rewritten link is
      // already root-relative.
      const target = workspacePathFromHref(href, rootPath) ?? rootRelativeFromHref(href);
      if (target === null) return;
      event.preventDefault();
      event.stopPropagation();
      open(target);
    };
    element.addEventListener("click", intercept, true);
    return () => element.removeEventListener("click", intercept, true);
  }, [rootPath]);

  return (
    <div
      ref={container}
      // BB's Markdown breakout also observes this scroller: `clientWidth`
      // shrinks when the vertical scrollbar appears, and an image loading can
      // push the document across that threshold — scrollbar in, breakout
      // narrower, layout shifts, scrollbar out, repeat. A stable gutter keeps
      // the observed width the same whether or not a scrollbar is present.
      style={{ scrollbarGutter: "stable" }}
      className="flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-y-auto overflow-x-hidden bg-background"
      data-testid="markdown-preview"
    >
      <EditorTabBoundary
        fileKey={path}
        path={path}
        content={content}
        phase="markdown-preview"
        context={{ extension: "md", bytes: content.length, sourceKind: source.kind, host: source.experimental_hostId ?? undefined }}
      >
        {/* BB's Markdown table breakout measures this root and writes its
            result back as CSS variables. Keep the measured box pinned to the
            pane: an intrinsic-width flex item lets a wide table alternately
            widen its own container and shrink it again on every observer pass,
            and inline-size containment makes that impossible — the box's width
            can never derive from its contents. Tables keep their own
            overflow-x-auto wrapper inside Markdown. */}
        <div className="mx-auto w-full min-w-0 max-w-3xl px-6 py-5" style={{ contain: "inline-size" }}>
          <Markdown
            content={rendered}
            className="w-full min-w-0"
            experimental_document={document ?? undefined}
          />
        </div>
      </EditorTabBoundary>
    </div>
  );
}
