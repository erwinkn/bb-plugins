// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXTERNAL_ATTRIBUTE, isPlainPrimaryClick, mountLinkInterception, pullRequestAnchorFromPath } from "./link-interception";
import { OPEN_PULL_REQUEST_EVENT, pickViewerTarget, threadIdFromPathname, type ViewerTarget } from "./open-pull-request";

function anchor(href: string, attributes: Record<string, string> = {}): HTMLAnchorElement {
  const node = document.createElement("a");
  node.setAttribute("href", href);
  node.target = "_blank";
  node.rel = "noopener noreferrer";
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  node.textContent = href;
  document.body.append(node);
  return node;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("pullRequestAnchorFromPath", () => {
  it("finds the PR anchor on the event path and ignores everything else", () => {
    const pr = anchor("https://github.com/acme/widgets/pull/7");
    const inner = document.createElement("code");
    pr.append(inner);
    expect(pullRequestAnchorFromPath([inner, pr, document.body])).toEqual({ anchor: pr, url: "https://github.com/acme/widgets/pull/7" });
    expect(pullRequestAnchorFromPath([anchor("https://github.com/acme/widgets/issues/7")])).toBeNull();
    expect(pullRequestAnchorFromPath([anchor("https://github.com/acme/widgets/pull/7", { [EXTERNAL_ATTRIBUTE]: "" })])).toBeNull();
    expect(pullRequestAnchorFromPath([anchor("https://github.com/acme/widgets/pull/7", { download: "" })])).toBeNull();
    expect(pullRequestAnchorFromPath([document.body])).toBeNull();
  });
});

describe("isPlainPrimaryClick", () => {
  it("accepts only an unmodified primary button", () => {
    expect(isPlainPrimaryClick(new MouseEvent("click", { button: 0 }))).toBe(true);
    for (const init of [{ button: 1 }, { button: 2 }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }]) {
      expect(isPlainPrimaryClick(new MouseEvent("click", { button: 0, ...init }))).toBe(false);
    }
    const prevented = new MouseEvent("click", { cancelable: true });
    prevented.preventDefault();
    expect(isPlainPrimaryClick(prevented)).toBe(false);
  });
});

describe("mountLinkInterception", () => {
  function click(node: Element, init: MouseEventInit = {}): MouseEvent {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, button: 0, ...init });
    node.dispatchEvent(event);
    return event;
  }

  it("dispatches the open request and blocks the default open", () => {
    const controller = new AbortController();
    const dispatch = vi.fn(() => true);
    const openExternally = vi.fn();
    mountLinkInterception({ signal: controller.signal }, { dispatch, openExternally });
    window.history.replaceState(null, "", "/projects/proj_1/threads/thr_42/some-tab");
    const pr = anchor("https://github.com/acme/widgets/pull/7");
    const downstream = vi.fn();
    pr.addEventListener("click", downstream);
    const event = click(pr);
    expect(event.defaultPrevented).toBe(true);
    expect(downstream).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ url: "https://github.com/acme/widgets/pull/7", threadId: "thr_42", element: pr });
    expect(openExternally).not.toHaveBeenCalled();
    controller.abort();
    expect(click(pr).defaultPrevented).toBe(false);
  });

  it("falls back to an external open when nobody handles the request", () => {
    const controller = new AbortController();
    const openExternally = vi.fn();
    mountLinkInterception({ signal: controller.signal }, { dispatch: () => false, openExternally });
    const pr = anchor("https://github.com/acme/widgets/pull/8");
    expect(click(pr).defaultPrevented).toBe(true);
    expect(openExternally).toHaveBeenCalledWith("https://github.com/acme/widgets/pull/8");
    controller.abort();
  });

  it("leaves modifier clicks, other buttons, opted-out and non-PR anchors alone", () => {
    const controller = new AbortController();
    const dispatch = vi.fn(() => true);
    mountLinkInterception({ signal: controller.signal }, { dispatch });
    const pr = anchor("https://github.com/acme/widgets/pull/7");
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(click(pr, init).defaultPrevented).toBe(false);
    }
    expect(click(anchor("https://github.com/acme/widgets/pull/7", { [EXTERNAL_ATTRIBUTE]: "" })).defaultPrevented).toBe(false);
    expect(click(anchor("https://github.com/acme/widgets/issues/7")).defaultPrevented).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    controller.abort();
  });

  it("uses the window event by default", () => {
    const controller = new AbortController();
    const openExternally = vi.fn();
    mountLinkInterception({ signal: controller.signal }, { openExternally });
    const seen: unknown[] = [];
    const handler = (event: Event) => {
      seen.push((event as CustomEvent).detail);
      event.preventDefault();
    };
    window.addEventListener(OPEN_PULL_REQUEST_EVENT, handler);
    click(anchor("https://github.com/acme/widgets/pull/7"));
    expect(seen).toEqual([expect.objectContaining({ url: "https://github.com/acme/widgets/pull/7" })]);
    expect(openExternally).not.toHaveBeenCalled();
    window.removeEventListener(OPEN_PULL_REQUEST_EVENT, handler);
    controller.abort();
  });
});

describe("threadIdFromPathname", () => {
  it("reads the thread from both route shapes", () => {
    expect(threadIdFromPathname("/projects/proj_1/threads/thr_1/files")).toBe("thr_1");
    expect(threadIdFromPathname("/threads/thr_2")).toBe("thr_2");
    expect(threadIdFromPathname("/plugins/github/github/pulls")).toBeNull();
    expect(threadIdFromPathname("/")).toBeNull();
  });
});

describe("pickViewerTarget", () => {
  function pane(threadId: string): { pane: HTMLElement; target: ViewerTarget; header: HTMLElement } {
    const paneNode = document.createElement("section");
    const header = document.createElement("span");
    paneNode.append(header);
    document.body.append(paneNode);
    return { pane: paneNode, header, target: { threadId, element: () => header, open: () => true } };
  }

  it("prefers the pane that contains the clicked element", () => {
    const a = pane("thr_a");
    const b = pane("thr_b");
    const link = document.createElement("a");
    b.pane.append(link);
    expect(pickViewerTarget({ url: "u", threadId: "thr_a", element: link }, [a.target, b.target])).toBe(b.target);
  });

  it("falls back to the thread id, then to a lone pane, else nothing", () => {
    const a = pane("thr_a");
    const b = pane("thr_b");
    expect(pickViewerTarget({ url: "u", threadId: "thr_b" }, [a.target, b.target])).toBe(b.target);
    expect(pickViewerTarget({ url: "u", threadId: "thr_zzz" }, [a.target, b.target])).toBeNull();
    expect(pickViewerTarget({ url: "u", threadId: null }, [a.target])).toBe(a.target);
    expect(pickViewerTarget({ url: "u", threadId: null }, [a.target, b.target])).toBeNull();
    expect(pickViewerTarget({ url: "u", threadId: null }, [])).toBeNull();
  });
});
