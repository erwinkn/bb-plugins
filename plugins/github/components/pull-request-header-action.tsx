// One instance per visible thread pane. It is the only plugin code that can
// open this pane's side panel (see lib/open-pull-request.ts), so it registers
// itself as a viewer target for "open pull request" requests, and shows a
// small PR count button when the thread has linked pull requests.
import { useEffect, useRef } from "react";
import { useBbNavigate, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { registerViewerTarget, takePendingOpen } from "../lib/open-pull-request";
import { useThreadPullRequests } from "./pull-requests-panel";
import { Button } from "./ui/button";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "./ui/coarse-pointer-sizing";
import { Icon } from "./ui/icon";
import { cn } from "../lib/utils";

export const PULL_PANEL_ACTION_ID = "pull";

export function PullRequestHeaderAction({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  const { list } = useThreadPullRequests(threadId);
  const element = useRef<HTMLSpanElement | null>(null);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    const open = (url: string) => navigateRef.current.openThreadPanel({ actionId: PULL_PANEL_ACTION_ID, title: "GitHub PR", params: { url } });
    const unregister = registerViewerTarget({ threadId, element: () => element.current, open });
    // A request that arrived before this pane existed (the overlay navigated here).
    const parked = takePendingOpen(threadId);
    if (parked !== null) open(parked);
    return unregister;
  }, [threadId]);

  const count = list?.links.length ?? 0;
  // The span is the registry's DOM anchor for split-pane matching; it stays
  // in the tree even when there is nothing to show.
  return (
    <span ref={element} className="contents" data-github-pull-request-target={threadId}>
      {count > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`${count} linked pull request${count === 1 ? "" : "s"}`}
          onClick={() => navigateRef.current.openThreadPanel({ actionId: PULL_PANEL_ACTION_ID, title: "GitHub PR", params: { list: true } })}
          className={cn(isCompactViewport ? COARSE_POINTER_HEADER_ICON_BUTTON_CLASS : "h-7 gap-1.5 px-2 text-xs")}
        >
          <Icon name="Github" aria-hidden />
          {isCompactViewport ? null : <>PR · {count}</>}
        </Button>
      ) : null}
    </span>
  );
}
