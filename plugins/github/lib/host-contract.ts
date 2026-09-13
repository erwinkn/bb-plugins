/**
 * Every BB fact the link interception and the open-request bridge rely on,
 * anchored to the BB source file that owns it and to strings that must appear
 * in the installed app bundle. `host-contract.test.ts` greps the bundle for
 * them, so a BB upgrade that changes a route shape, the anchor rendering, or
 * the slot names fails loudly here instead of silently in the app.
 *
 * Bundle strings are exact substrings of BB 0.43.1's minified frontend
 * (`app/dist/assets/*.js`); the minifier uses backtick strings.
 */
export interface HostAnchor {
  /** BB source file (repo-relative) that owns the fact. */
  source: string;
  /** Substrings that must all appear somewhere in the frontend chunks. */
  mustContain: readonly string[];
  /** What the plugin does with this fact. */
  because: string;
}

export const HOST_ANCHORS: readonly HostAnchor[] = [
  {
    source: "apps/app/src/components/ui/markdown-preview.tsx (MarkdownAnchor)",
    mustContain: ["noopener noreferrer"],
    because: "Markdown links render as real anchors with target=_blank; the content script intercepts their click in the capture phase.",
  },
  {
    source: "apps/app/src/lib/url-open-routing.tsx (openExternalUrl fallback)",
    mustContain: ["noopener,noreferrer"],
    because: "The browser build ends in window.open(url, _blank, noopener,noreferrer); the content script's fallback mirrors it.",
  },
  {
    source: "apps/app/src/hooks/useRouteState.ts (thread route patterns)",
    mustContain: ["/projects/:projectId/threads/:threadId", "/threads/:threadId"],
    because: "threadIdFromPathname reads the thread in view from these two route shapes.",
  },
  {
    source: "packages/plugin-sdk/src/app-contract.ts (slots used by app.tsx)",
    mustContain: ["experimental_threadHeaderAction", "experimental_appOverlay", "openThreadPanel", "contentScripts"],
    because: "The header action opens the panel tab, the overlay routes unhandled requests, the content script listens for clicks.",
  },
];
