// App-level fallback for "open pull request" requests no thread pane took:
// navigate to the named thread and park the URL for its header action, or,
// without a thread, open the URL with BB's browser preference. Renders
// nothing; the overlay slot is only the way to get an app-wide component
// with `useBbNavigate`. It registers a fallback with the bridge rather than
// its own window listener so pane targets always get the request first.
import { useEffect, useRef } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { registerOpenPullRequestFallback, setPendingOpen, threadIdFromPathname } from "../lib/open-pull-request";

export function OpenPullRequestOverlay() {
  const navigate = useBbNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(
    () =>
      registerOpenPullRequestFallback((detail) => {
        const current = threadIdFromPathname(window.location.pathname);
        if (detail.threadId !== null && detail.threadId !== current) {
          setPendingOpen(detail.threadId, detail.url);
          navigateRef.current.toThread(detail.threadId);
          return true;
        }
        return navigateRef.current.openUrl(detail.url);
      }),
    [],
  );
  return null;
}
