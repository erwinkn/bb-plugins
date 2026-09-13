/**
 * The bridge between "something wants to open a PR in the viewer" and the
 * thread panel that can show it.
 *
 * BB has no plugin hook in its URL router and no thread-targeted
 * `openThreadPanel`: only a component mounted inside a thread view (here the
 * `experimental_threadHeaderAction`) can open that thread's side panel
 * (apps/app/src/views/thread-detail/ThreadDetailView.tsx:3037, the
 * `PluginThreadPanelNavigationProvider`). So the plugin routes requests
 * through one window-level DOM event that any code, including other
 * plugins, can dispatch:
 *
 *   const event = new CustomEvent("bb-plugins:open-pull-request", {
 *     cancelable: true,
 *     detail: { url, threadId },        // threadId may be null
 *   });
 *   window.dispatchEvent(event);
 *   if (!event.defaultPrevented) { /* nothing could show it; open externally *\/ }
 *
 * Handling order, all inside the registry's one window listener so it does
 * not depend on DOM listener ordering (at the target phase browsers run
 * window listeners in registration order, capture flag or not — a separate
 * overlay listener registered first would steal requests meant for a pane):
 *   1. the mounted thread panes: `pickViewerTarget` chooses the one that
 *      should show the PR and opens its panel tab;
 *   2. the app overlay's registered fallback runs next on an unhandled
 *      request: with a thread id it navigates there and parks the URL so the
 *      header action opens the tab once it mounts; without one it opens the
 *      URL with BB's browser preference;
 *   3. the dispatcher falls back to an external open when nobody prevented
 *      the default.
 */

export const OPEN_PULL_REQUEST_EVENT = "bb-plugins:open-pull-request";

export interface OpenPullRequestDetail {
  /** Canonical or as-clicked PR URL. */
  url: string;
  /** The thread whose viewer should show it, when the dispatcher knows. */
  threadId: string | null;
  /** The clicked element, when there is one; used to pick the right split pane. */
  element?: Element | null;
}

/** Dispatch the event; true when a listener took the request. */
export function requestOpenPullRequest(detail: OpenPullRequestDetail): boolean {
  const event = new CustomEvent<OpenPullRequestDetail>(OPEN_PULL_REQUEST_EVENT, { cancelable: true, detail });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

export function detailOf(event: Event): OpenPullRequestDetail | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const record = detail as Record<string, unknown>;
  if (typeof record.url !== "string") return null;
  return {
    url: record.url,
    threadId: typeof record.threadId === "string" ? record.threadId : null,
    element: record.element instanceof Element ? record.element : null,
  };
}

/**
 * The thread route in view. BB mounts a thread at
 * `/projects/:projectId/threads/:threadId/*` or `/threads/:threadId/*`
 * (apps/app/src/hooks/useRouteState.ts:20-22). In a split layout only the
 * primary pane is in the URL, so callers prefer element matching.
 */
export function threadIdFromPathname(pathname: string): string | null {
  const match = /^(?:\/projects\/[^/]+)?\/threads\/([^/?#]+)/.exec(pathname);
  return match === null ? null : decodeURIComponent(match[1]!);
}

/** A mounted thread pane that can open the viewer tab. */
export interface ViewerTarget {
  threadId: string;
  /** The header action's own DOM node, for split-pane disambiguation. */
  element: () => Element | null;
  open: (url: string) => boolean;
}

function depthOf(node: Node): number {
  let depth = 0;
  for (let current: Node | null = node; current !== null; current = current.parentNode) depth += 1;
  return depth;
}

/** Depth of the deepest ancestor shared by both nodes, or -1 without one. */
function commonAncestorDepth(a: Node, b: Node): number {
  const ancestors = new Set<Node>();
  for (let current: Node | null = a; current !== null; current = current.parentNode) ancestors.add(current);
  for (let current: Node | null = b; current !== null; current = current.parentNode) {
    if (ancestors.has(current)) return depthOf(current);
  }
  return -1;
}

/**
 * Which pane shows the PR. A clicked element wins (the pane whose header is
 * closest in the DOM tree), then an explicit thread id, then a lone pane.
 */
export function pickViewerTarget(detail: OpenPullRequestDetail, targets: readonly ViewerTarget[]): ViewerTarget | null {
  if (targets.length === 0) return null;
  const element = detail.element ?? null;
  if (element !== null && element.isConnected) {
    let best: { target: ViewerTarget; depth: number } | null = null;
    for (const target of targets) {
      const node = target.element();
      if (node === null || !node.isConnected) continue;
      const depth = commonAncestorDepth(node, element);
      if (depth >= 0 && (best === null || depth > best.depth)) best = { target, depth };
    }
    if (best !== null) return best.target;
  }
  if (detail.threadId !== null) {
    const byThread = targets.find((target) => target.threadId === detail.threadId);
    if (byThread !== undefined) return byThread;
    // A thread id that names no mounted pane is a navigation request, not
    // something another pane should swallow.
    return null;
  }
  return targets.length === 1 ? targets[0]! : null;
}

const targets = new Set<ViewerTarget>();
let listening = false;

/**
 * Who handles a request no pane took — the app overlay's router. A direct
 * call, not a second window listener, so it deterministically runs after the
 * pane targets within the same dispatch.
 */
export type OpenPullRequestFallback = (detail: OpenPullRequestDetail) => boolean;
let fallback: OpenPullRequestFallback | null = null;

function onRequest(event: Event) {
  if (event.defaultPrevented) return;
  const detail = detailOf(event);
  if (detail === null) return;
  const target = pickViewerTarget(detail, [...targets]);
  if (target !== null && target.open(detail.url)) {
    event.preventDefault();
    return;
  }
  if (fallback?.(detail)) event.preventDefault();
}

// The listener is up while a pane target or the overlay fallback exists.
function updateListening() {
  const needed = targets.size > 0 || fallback !== null;
  if (needed === listening) return;
  listening = needed;
  if (needed) window.addEventListener(OPEN_PULL_REQUEST_EVENT, onRequest, { capture: true });
  else window.removeEventListener(OPEN_PULL_REQUEST_EVENT, onRequest, { capture: true });
}

/** Mounted by every header action; the first registration installs the listener. */
export function registerViewerTarget(target: ViewerTarget): () => void {
  targets.add(target);
  updateListening();
  return () => {
    targets.delete(target);
    updateListening();
  };
}

/** Mounted once by the app overlay; also installs the listener on its own. */
export function registerOpenPullRequestFallback(handler: OpenPullRequestFallback): () => void {
  fallback = handler;
  updateListening();
  return () => {
    if (fallback === handler) fallback = null;
    updateListening();
  };
}

// A request for a thread that is not in view: the overlay navigates there
// and parks the URL; the header action opens it on mount.
const pending = new Map<string, string>();
export function setPendingOpen(threadId: string, url: string): void {
  pending.set(threadId, url);
}
export function takePendingOpen(threadId: string): string | null {
  const url = pending.get(threadId) ?? null;
  pending.delete(threadId);
  return url;
}

/** Test hook: forget every target, the fallback, and parked requests. */
export function resetOpenPullRequestBridge(): void {
  for (const target of [...targets]) registerViewerTarget(target)();
  targets.clear();
  fallback = null;
  updateListening();
  pending.clear();
}
