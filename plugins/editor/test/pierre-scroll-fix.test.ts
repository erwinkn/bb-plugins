import { afterEach, describe, expect, it, vi } from "vitest";
import { acquirePierreScrollRevealFix } from "@/lib/pierre-scroll-fix";

const SCROLL_CONTAINER_TESTID = "pierre-scroll-container";

interface FakeView {
  calls: Array<{ type: string; position: number; behavior?: string }>;
  getTopForItem(id: string): number | undefined;
  getHeight(): number;
  scrollTo(target: { type: string; position: number; behavior?: string }): void;
}

/**
 * A CodeView stand-in. `height` is the viewport height; jsdom reports
 * clientHeight 0, which is why the reveal asks the view instead of measuring
 * the host. `pageOffset` emulates Pierre's scrollPageOffset: when nonzero the
 * view resolves the logical position onto the paged scaffold and reports the
 * physical scrollTop in `appliedPaged`.
 */
function fakeView({ itemTop = 100, height = 600, pageOffset = 0 } = {}) {
  const view: FakeView & { appliedPaged: number | null } = {
    calls: [],
    appliedPaged: null,
    getTopForItem: () => itemTop,
    getHeight: () => height,
    scrollTo(target) {
      view.calls.push(target);
      view.appliedPaged = Math.max(0, target.position - pageOffset);
    },
  };
  return view;
}

function scrollHost(): HTMLElement {
  const host = document.createElement("div");
  host.dataset.testid = SCROLL_CONTAINER_TESTID;
  Object.defineProperty(host, "clientHeight", { value: 600, configurable: true });
  document.body.append(host);
  return host;
}

/** The probe #scrollToLine appends to #fileContainer.shadowRoot. */
function attachProbe(host: HTMLElement, topPx: number): { probe: HTMLDivElement; fileContainer: HTMLElement } {
  const fileContainer = document.createElement("div");
  const shadow = fileContainer.attachShadow({ mode: "open" });
  host.append(fileContainer);
  const probe = document.createElement("div");
  probe.style.cssText = `position:absolute;left:0;width:2px;height:18px;top:${topPx}px;scroll-margin:0px 8px 0px 80px`;
  shadow.append(probe);
  return { probe, fileContainer };
}

const releases: Array<() => void> = [];
function acquire(host: HTMLElement, view: FakeView, itemId = "doc"): () => void {
  const release = acquirePierreScrollRevealFix(host, view, itemId);
  releases.push(release);
  return release;
}

afterEach(() => {
  while (releases.length > 0) releases.pop()!();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("pierre scroll reveal fix", () => {
  it("routes the probe through the owning CodeView's logical scrollTo", () => {
    const host = scrollHost();
    const view = fakeView({ itemTop: 100, height: 600 });
    acquire(host, view);
    const { probe } = attachProbe(host, 4000);
    probe.scrollIntoView({ block: "center", inline: "nearest" });
    // 100 (item top) + 4000 (probe top) centered in a 600 viewport.
    expect(view.calls).toEqual([{ type: "position", position: 4100 - 300 + 9, behavior: "instant" }]);
    // The fix never writes the physical scroller; paging is Pierre's domain.
    expect(host.scrollTop).toBe(0);
    host.remove();
  });

  it("centers the probe's margin box, matching block:center", () => {
    const host = scrollHost();
    const view = fakeView({ itemTop: 0, height: 600 });
    acquire(host, view);
    const { probe } = attachProbe(host, 4000);
    probe.style.scrollMargin = "48px 8px 0px 80px";
    probe.scrollIntoView({ block: "center", inline: "nearest" });
    // margin box top 4000-48, height 18+48: center = 3952+33 → scroll 3685.
    expect(view.calls[0]?.position).toBe(4000 - 24 + 9 - 300);
    host.remove();
  });

  it("clamps the centered target at the document top", () => {
    const host = scrollHost();
    const view = fakeView({ itemTop: 0, height: 600 });
    acquire(host, view);
    const { probe } = attachProbe(host, 40);
    probe.scrollIntoView({ block: "center" });
    expect(view.calls[0]?.position).toBe(0);
    host.remove();
  });

  it("delegates the logical position to the view when the page offset is nonzero", () => {
    const host = scrollHost();
    // A document past Pierre's rebase point: scrollPageOffset is nonzero, so
    // the physical scrollTop diverges from the logical position. The fix must
    // hand the logical target to the view rather than writing host.scrollTop.
    const view = fakeView({ itemTop: 0, height: 600, pageOffset: 2_000_000 });
    acquire(host, view);
    const { probe } = attachProbe(host, 3_000_000);
    probe.scrollIntoView({ block: "center" });
    expect(view.calls[0]?.position).toBe(3_000_000 + 9 - 300);
    expect(host.scrollTop).toBe(0);
    // The paged view resolves the same logical target onto physical scroll.
    expect(view.appliedPaged).toBe(3_000_000 + 9 - 300 - 2_000_000);
    host.remove();
  });

  it("passes non-probe elements to the delegate with receiver and arguments", () => {
    const delegate = vi.fn();
    const previous = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Element.prototype.scrollIntoView = delegate;
    try {
      const host = scrollHost();
      acquire(host, fakeView());
      const ordinary = document.createElement("div");
      ordinary.style.cssText = "position:absolute;top:5000px;width:40px";
      host.append(ordinary);
      ordinary.scrollIntoView({ block: "end" });
      expect(delegate).toHaveBeenCalledTimes(1);
      expect(delegate.mock.instances[0]).toBe(ordinary);
      expect(delegate).toHaveBeenCalledWith({ block: "end" });
      // A probe-shaped div inside an element parent is Pierre's overlay path;
      // it stays on the delegate too.
      const { shadow } = (() => {
        const fileContainer = document.createElement("div");
        const shadowRoot = fileContainer.attachShadow({ mode: "open" });
        host.append(fileContainer);
        return { shadow: shadowRoot };
      })();
      const wrapped = document.createElement("div");
      shadow.append(wrapped);
      const nested = document.createElement("div");
      nested.style.cssText = "position:absolute;left:0;width:2px;height:18px;top:6000px;scroll-margin:0px 8px 0px 80px";
      wrapped.append(nested);
      nested.scrollIntoView({ block: "center" });
      expect(delegate).toHaveBeenCalledTimes(2);
      expect(delegate.mock.instances[1]).toBe(nested);
      host.remove();
    } finally {
      if (previous === undefined) delete Element.prototype.scrollIntoView;
      else Object.defineProperty(Element.prototype, "scrollIntoView", previous);
    }
  });

  it("leaves probes on hosts without a registered surface to the delegate", () => {
    const delegate = vi.fn();
    const previous = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Element.prototype.scrollIntoView = delegate;
    try {
      const registered = scrollHost();
      acquire(registered, fakeView());
      const outside = scrollHost(); // same testid shape, no surface registered
      const { probe } = attachProbe(outside, 3988);
      probe.scrollIntoView({ block: "center" });
      expect(delegate).toHaveBeenCalledTimes(1);
      expect(delegate.mock.instances[0]).toBe(probe);
      registered.remove();
      outside.remove();
    } finally {
      if (previous === undefined) delete Element.prototype.scrollIntoView;
      else Object.defineProperty(Element.prototype, "scrollIntoView", previous);
    }
  });

  it("installs once across mounts and keeps routing until the last release", () => {
    const hostA = scrollHost();
    const hostB = scrollHost();
    const viewB = fakeView({ itemTop: 0, height: 600 });
    const releaseA = acquire(hostA, fakeView());
    const patched = HTMLDivElement.prototype.scrollIntoView;
    expect(typeof patched).toBe("function");
    acquire(hostB, viewB);
    // Second mount reuses the same wrapper instead of layering a new one.
    expect(HTMLDivElement.prototype.scrollIntoView).toBe(patched);
    releaseA();
    // hostB's surface remains registered and still routes probes to its view.
    const { probe } = attachProbe(hostB, 4000);
    probe.scrollIntoView({ block: "center" });
    expect(viewB.calls).toHaveLength(1);
    hostA.remove();
    hostB.remove();
  });

  it("restores the delegate installed before it", () => {
    const delegate = vi.fn();
    const own = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollIntoView");
    HTMLDivElement.prototype.scrollIntoView = delegate;
    const host = scrollHost();
    const release = acquire(host, fakeView());
    expect(HTMLDivElement.prototype.scrollIntoView).not.toBe(delegate);
    release();
    // The prior own-property wrapper is restored, not replaced by ours.
    expect(HTMLDivElement.prototype.scrollIntoView).toBe(delegate);
    host.remove();
    if (own === undefined) delete HTMLDivElement.prototype.scrollIntoView;
    else Object.defineProperty(HTMLDivElement.prototype, "scrollIntoView", own);
  });

  it("does not cycle when a wrapper is layered above the active hook", () => {
    // The A48 repro: acquire → a delegating third-party wrapper captures the
    // active hook → second acquire. The reacquire must leave the chain
    // installed instead of capturing the outer wrapper as the delegate.
    let nativeReceiver: Element | undefined;
    const native = vi.fn(function (this: Element) {
      nativeReceiver = this;
    });
    const previousElement = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Element.prototype.scrollIntoView = native;
    const ownDiv = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollIntoView");
    try {
      const hostA = scrollHost();
      acquire(hostA, fakeView());
      const inner = HTMLDivElement.prototype.scrollIntoView;
      let outerCalls = 0;
      HTMLDivElement.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
        outerCalls += 1;
        if (outerCalls > 4) throw new Error("delegation cycle");
        return inner.call(this, arg);
      };
      const hostB = scrollHost();
      const viewB = fakeView({ itemTop: 0, height: 600 });
      acquire(hostB, viewB);
      const ordinary = document.createElement("div");
      hostB.append(ordinary);
      ordinary.scrollIntoView({ block: "end" });
      expect(outerCalls).toBe(1);
      expect(native).toHaveBeenCalledTimes(1);
      expect(native).toHaveBeenCalledWith({ block: "end" });
      expect(nativeReceiver).toBe(ordinary);
      // The hook stays reachable through the outer wrapper and still routes
      // the second surface's probe to its own view.
      const { probe } = attachProbe(hostB, 4000);
      probe.scrollIntoView({ block: "center" });
      expect(viewB.calls).toHaveLength(1);
      expect(native).toHaveBeenCalledTimes(1);
      hostA.remove();
      hostB.remove();
    } finally {
      if (ownDiv === undefined) delete HTMLDivElement.prototype.scrollIntoView;
      else Object.defineProperty(HTMLDivElement.prototype, "scrollIntoView", ownDiv);
      if (previousElement === undefined) delete Element.prototype.scrollIntoView;
      else Object.defineProperty(Element.prototype, "scrollIntoView", previousElement);
    }
  });

  it("reacquires above a stale wrapper left by an unrestored release", () => {
    // Final release while an outer wrapper sits on top cannot restore the
    // prototype, so the retired patch stays installed as the wrapper's
    // delegate. A later acquire installs a fresh patch capturing the wrapper;
    // the stale patch below must delegate to what it captured at install —
    // never to the new record's `original`, which would call the wrapper
    // back into it.
    let nativeReceiver: Element | undefined;
    const native = vi.fn(function (this: Element) {
      nativeReceiver = this;
    });
    const previousElement = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Element.prototype.scrollIntoView = native;
    const ownDiv = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollIntoView");
    try {
      const hostA = scrollHost();
      const releaseA = acquire(hostA, fakeView());
      const inner = HTMLDivElement.prototype.scrollIntoView;
      let outerCalls = 0;
      HTMLDivElement.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
        outerCalls += 1;
        if (outerCalls > 4) throw new Error("delegation cycle");
        return inner.call(this, arg);
      };
      releaseA();
      const hostB = scrollHost();
      const viewB = fakeView({ itemTop: 0, height: 600 });
      acquire(hostB, viewB);
      const ordinary = document.createElement("div");
      hostB.append(ordinary);
      ordinary.scrollIntoView({ block: "end" });
      expect(outerCalls).toBe(1);
      expect(native).toHaveBeenCalledTimes(1);
      expect(native).toHaveBeenCalledWith({ block: "end" });
      expect(nativeReceiver).toBe(ordinary);
      const { probe } = attachProbe(hostB, 4000);
      probe.scrollIntoView({ block: "center" });
      expect(viewB.calls).toHaveLength(1);
      expect(native).toHaveBeenCalledTimes(1);
      hostA.remove();
      hostB.remove();
    } finally {
      if (ownDiv === undefined) delete HTMLDivElement.prototype.scrollIntoView;
      else Object.defineProperty(HTMLDivElement.prototype, "scrollIntoView", ownDiv);
      if (previousElement === undefined) delete Element.prototype.scrollIntoView;
      else Object.defineProperty(Element.prototype, "scrollIntoView", previousElement);
    }
  });
});
