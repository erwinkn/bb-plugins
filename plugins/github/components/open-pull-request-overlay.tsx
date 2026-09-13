// App-level fallback for "open pull request" requests no thread pane took:
// navigate to the named thread and park the URL for its header action, or,
// without a thread, open the URL with BB's browser preference. Renders
// nothing; the overlay slot is only the way to get an app-wide component
// with `useBbNavigate`.
import { useEffect, useRef } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { OPEN_PULL_REQUEST_EVENT, detailOf, setPendingOpen, threadIdFromPathname } from "../lib/open-pull-request";

export function OpenPullRequestOverlay() {
  const navigate = useBbNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    const onRequest = (event: Event) => {
      if (event.defaultPrevented) return;
      const detail = detailOf(event);
      if (detail === null) return;
      const current = threadIdFromPathname(window.location.pathname);
      if (detail.threadId !== null && detail.threadId !== current) {
        setPendingOpen(detail.threadId, detail.url);
        navigateRef.current.toThread(detail.threadId);
        event.preventDefault();
        return;
      }
      if (navigateRef.current.openUrl(detail.url)) event.preventDefault();
    };
    // Bubble phase: runs after the header-action registry's capture listener.
    window.addEventListener(OPEN_PULL_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(OPEN_PULL_REQUEST_EVENT, onRequest);
  }, []);
  return null;
}
