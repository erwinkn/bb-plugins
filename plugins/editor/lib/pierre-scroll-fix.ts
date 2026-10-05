import type { CodeViewPositionScrollTarget } from "@pierre/diffs";

/**
 * Pierre 1.4.1 reveals a caret on an unrendered line by appending a probe
 * element to `#fileContainer.shadowRoot` and calling `scrollIntoView` on it
 * (`Editor.#scrollToLine`). The probe's `style.top` is a document offset, but
 * the file container is positioned at the start of the rendered window, so
 * the browser scrolls to `windowTop + top` — past the document end whenever
 * the caret sits far above the window. The target line stays unrendered, so
 * Pierre retries on the next render, pinning the scroll at the document
 * bottom and swallowing every attempt to scroll back toward line 1.
 *
 * The probe is recognizable: an empty absolutely positioned 2px div with a
 * scroll-margin, appended directly to a shadow root inside the scroll
 * container, carrying a numeric `style.top` in document space. Intercepting
 * that one call and re-issuing it through the owning CodeView's logical
 * `scrollTo({ type: "position" })` gives Pierre the target it wanted in its
 * own coordinate space, so the reveal converges. Routing through CodeView
 * also keeps the fix correct for documents large enough to rebase the paged
 * scroll scaffold (`scrollPageOffset` ≠ 0), where the logical offset and the
 * physical `scrollTop` diverge; everything else, including Pierre's
 * same-shaped probe in the overlay layer (which has an element parent, not a
 * shadow root), keeps the native behavior.
 *
 * The interception patches `HTMLDivElement.prototype.scrollIntoView` — the
 * probe is always a plain div — so other element types never enter the
 * wrapper. The patch record lives on `globalThis` under a `Symbol.for` key:
 * a reloaded plugin bundle adopts the existing record instead of layering a
 * second wrapper, and the last surface to release restores the prototype.
 * Each patch keeps the delegate it replaced in its own closure, so the chain
 * is immutable: an outer wrapper installed above an active patch can never
 * become the patch's own delegate, which would recurse it.
 */

const SCROLL_CONTAINER_TESTID = "pierre-scroll-container";
const RECORD_KEY = Symbol.for("bb-plugins.editor.pierre-scroll-reveal");

type NativeScrollIntoView = (this: Element, arg?: boolean | ScrollIntoViewOptions) => void;

/** The CodeView slice the reveal needs; the real view satisfies it exactly. */
interface RevealScrollView {
  scrollTo(target: CodeViewPositionScrollTarget): void;
  getTopForItem(id: string): number | undefined;
  getHeight(): number;
}

interface RevealRecord {
  patched: NativeScrollIntoView;
  /** The own property `HTMLDivElement.prototype` held before we patched it. */
  original: NativeScrollIntoView | undefined;
  refCount: number;
  surfaces: WeakMap<Element, { view: RevealScrollView; itemId: string }>;
}

function revealRecord(): RevealRecord | undefined {
  return (globalThis as { [key: symbol]: RevealRecord | undefined })[RECORD_KEY];
}

function setRevealRecord(record: RevealRecord | undefined): void {
  const global = globalThis as { [key: symbol]: RevealRecord | undefined };
  if (record === undefined) delete global[RECORD_KEY];
  else global[RECORD_KEY] = record;
}

/** Walks light-DOM parents and shadow hosts up to the document. */
function scrollContainerOf(element: Element): HTMLElement | null {
  let node: Node | null = element;
  while (node !== null) {
    if (node instanceof HTMLElement && node.dataset.testid === SCROLL_CONTAINER_TESTID) return node;
    node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null);
  }
  return null;
}

/**
 * Pierre's unrendered-line probe, identified by the exact contract
 * `#scrollToLine` builds: `h("div", { position: "absolute", left: "0",
 * width: "2px", height: lineHeight + "px", scrollMargin })` with `style.top`
 * set before it is appended to `#fileContainer.shadowRoot`.
 */
function isPierreScrollProbe(element: Element): element is HTMLDivElement {
  return (
    element instanceof HTMLDivElement &&
    element.parentNode instanceof ShadowRoot &&
    element.childElementCount === 0 &&
    element.style.position === "absolute" &&
    element.style.left === "0px" &&
    element.style.width === "2px" &&
    element.style.height.endsWith("px") &&
    element.style.top.endsWith("px") &&
    element.style.scrollMargin !== ""
  );
}

/**
 * Re-issues the probe's reveal through the CodeView so the logical document
 * offset is resolved by Pierre's own paging (`resolvePagedScrollPosition`)
 * instead of being written to the physical `scrollTop`. Returns false when
 * the probe cannot be mapped and the caller should fall back to native.
 */
function revealProbe(view: RevealScrollView, itemId: string, probe: HTMLDivElement): boolean {
  const probeTop = Number.parseFloat(probe.style.top);
  if (!Number.isFinite(probeTop)) return false;
  const probeHeight = Number.parseFloat(probe.style.height) || 0;
  const marginTop = Number.parseFloat(probe.style.scrollMargin) || 0;
  // The probe's document-space top is relative to its item's content; the
  // position target is logical document-space. `block: "center"` centers the
  // probe's margin box, so the search-panel top margin shifts it by half.
  const documentTop = (view.getTopForItem(itemId) ?? 0) + probeTop;
  const centered = documentTop - marginTop / 2 + probeHeight / 2 - view.getHeight() / 2;
  view.scrollTo({ type: "position", position: Math.max(0, centered), behavior: "instant" });
  return true;
}

/**
 * Installs the shared patch once. The record's `original` and the patched
 * function's delegate are the same immutable value, captured before install;
 * acquires that find the record already installed never touch the prototype,
 * so the delegation chain stays exactly as installed.
 */
function installRevealPatch(): RevealRecord {
  const own = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollIntoView");
  const original = own?.value as NativeScrollIntoView | undefined;
  const patched: NativeScrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions): void {
    const live = revealRecord();
    if (live !== undefined && isPierreScrollProbe(this)) {
      const scrollHost = scrollContainerOf(this);
      const surface = scrollHost === null ? undefined : live.surfaces.get(scrollHost);
      try {
        if (surface !== undefined && revealProbe(surface.view, surface.itemId, this)) return;
      } catch {
        // A failing reveal must not propagate into Pierre's synchronous
        // render; fall through to the native behavior instead.
      }
    }
    // Delegate to the function this patch replaced, captured at install —
    // never to anything read back from the prototype. An outer wrapper that
    // delegates into this patch stays above it in the chain; making it our
    // delegate would recurse.
    const delegate = typeof original === "function" ? original : Element.prototype.scrollIntoView;
    if (typeof delegate === "function") delegate.call(this, arg);
  };
  Object.defineProperty(HTMLDivElement.prototype, "scrollIntoView", {
    writable: true,
    configurable: true,
    value: patched,
  });
  return { original, patched, refCount: 0, surfaces: new WeakMap() };
}

/**
 * Registers a surface's scroll host with the shared reveal interception and
 * returns a release function for the surface's unmount. Ref-counted across
 * all mounted surfaces; after the last release the prototype is restored.
 */
export function acquirePierreScrollRevealFix(
  host: HTMLElement,
  view: RevealScrollView,
  itemId: string,
): () => void {
  if (typeof HTMLDivElement === "undefined") return () => {};
  let record = revealRecord();
  if (record === undefined) {
    record = installRevealPatch();
    setRevealRecord(record);
  }
  // While the record exists the prototype is left untouched: if our patch is
  // on top it already handles calls, and if a delegating wrapper was layered
  // above it, calls still reach it through that wrapper.
  record.refCount += 1;
  record.surfaces.set(host, { view, itemId });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    record.surfaces.delete(host);
    record.refCount -= 1;
    if (record.refCount > 0) return;
    // Restore only while our patch is still on top; a third-party wrapper
    // installed over ours owns the prototype now.
    if (HTMLDivElement.prototype.scrollIntoView === record.patched) {
      if (record.original === undefined) Reflect.deleteProperty(HTMLDivElement.prototype, "scrollIntoView");
      else HTMLDivElement.prototype.scrollIntoView = record.original;
    }
    if (revealRecord() === record) setRevealRecord(undefined);
  };
}
