/**
 * Content script: turn clicks on GitHub pull request links into "open in the
 * PR viewer" requests.
 *
 * This is a DOM-level hack, accepted for v1 because BB 0.43.1 exposes no
 * plugin hook in its URL router. Everything it depends on is listed here so a
 * BB upgrade can be checked against `host-contract.test.ts`:
 *
 * - Markdown links in user and assistant messages render as a real `<a>` with
 *   `target="_blank" rel="noopener noreferrer"` through `MarkdownAnchor`
 *   (apps/app/src/components/ui/markdown-preview.tsx:565-647). Bare URLs are
 *   autolinked by remark-gfm, so they reach the same anchor.
 * - The SDK `UrlLink` renders a `RouteAnchor` / `<a>` whose React onClick
 *   routes through `navigation.openUrl` (apps/app/src/components/plugin/PluginUrlLink.tsx:32).
 * - Both paths open the URL with the client's browser preference, ending in
 *   `window.open(url, "_blank", "noopener,noreferrer")` in the browser build
 *   (apps/app/src/lib/url-open-routing.tsx:32) or `shell.openExternal` on
 *   the desktop. A document-level capture listener runs before React's root
 *   listener, so stopping propagation there keeps BB from opening the URL a
 *   second time.
 * - BB wraps plugin DOM listeners in an isolation context that refuses to
 *   reparent host nodes (apps/app/src/lib/foreign-dom-mutation-guard.ts:391);
 *   this script never touches the DOM, it only listens.
 * - Tool-row titles and command output are plain spans, not anchors
 *   (packages/thread-view/src/timeline-row-title.ts:64-76), so PR URLs printed
 *   by a command are not intercepted. That is a known limit, not a bug here.
 *
 * Out of scope on purpose: modifier clicks (cmd/ctrl/shift/alt) and non-primary
 * buttons keep their browser behavior, so a new-tab open still works; anchors
 * marked `data-github-open-external` (the viewer's own "Open on GitHub" link,
 * or any other plugin's) pass through.
 */
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import { parsePullRequestUrl } from "./pull-request-url";
import { requestOpenPullRequest, threadIdFromPathname, type OpenPullRequestDetail } from "./open-pull-request";

/** Set this attribute on an anchor to keep the interception off it. */
export const EXTERNAL_ATTRIBUTE = "data-github-open-external";

export interface InterceptedLink {
  anchor: HTMLAnchorElement;
  url: string;
}

/** The nearest anchor on the event path that names a PR and is not opted out. */
export function pullRequestAnchorFromPath(path: readonly EventTarget[]): InterceptedLink | null {
  for (const node of path) {
    if (!(node instanceof HTMLAnchorElement)) continue;
    if (node.hasAttribute(EXTERNAL_ATTRIBUTE) || node.hasAttribute("download")) return null;
    const href = node.getAttribute("href");
    if (href === null) return null;
    let url: string;
    try {
      url = new URL(href, window.location.href).href;
    } catch {
      return null;
    }
    return parsePullRequestUrl(url) === null ? null : { anchor: node, url };
  }
  return null;
}

/** Primary button, no modifiers, nothing else claimed it. */
export function isPlainPrimaryClick(event: MouseEvent): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

export interface LinkInterceptionOptions {
  /** Defaults to dispatching the window event; returns true when handled. */
  dispatch?: (detail: OpenPullRequestDetail) => boolean;
  /** Fallback when nothing handled the request; defaults to a new browser tab. */
  openExternally?: (url: string) => void;
}

export function openInNewTab(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** `app.contentScripts.register` mount: installs one capture listener until the signal aborts. */
export function mountLinkInterception(
  { signal }: Pick<PluginContentScriptContext, "signal">,
  options: LinkInterceptionOptions = {},
): () => void {
  const dispatch = options.dispatch ?? requestOpenPullRequest;
  const openExternally = options.openExternally ?? openInNewTab;
  const onClick = (event: Event) => {
    if (!(event instanceof MouseEvent) || !isPlainPrimaryClick(event)) return;
    const hit = pullRequestAnchorFromPath(event.composedPath());
    if (hit === null) return;
    event.preventDefault();
    event.stopPropagation();
    const handled = dispatch({ url: hit.url, threadId: threadIdFromPathname(window.location.pathname), element: hit.anchor });
    if (!handled) openExternally(hit.url);
  };
  document.addEventListener("click", onClick, { capture: true, signal });
  const dispose = () => document.removeEventListener("click", onClick, { capture: true });
  if (signal.aborted) dispose();
  return dispose;
}
