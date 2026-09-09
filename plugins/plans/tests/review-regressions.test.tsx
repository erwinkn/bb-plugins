// @vitest-environment jsdom
/**
 * Regression tests for the review findings on the plan review UI. Each test
 * describes what a reviewer does and what they must see; none of them mirror
 * the implementation. They drive PlanDocument and useReviewDraft through their
 * public props and the browser APIs a user's selection goes through.
 *
 * The host Markdown renderer is opaque, so it is replaced with a tiny block
 * renderer that produces the same kind of DOM: headings, paragraphs, lists,
 * and a code block with a Copy button.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planSchema, commentSchema } from "../contract";
import type { Plan, PlanComment } from "../contract";
import { readDraft } from "../lib/draft-store";
import { ACTIVE_HIGHLIGHT_NAME, HIGHLIGHT_NAME } from "../lib/highlight-registry";
import { commentsForVersion } from "../lib/plan-model";
import { MAX_QUOTE_LENGTH, type QuoteMatch } from "../lib/quote-anchor";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  Markdown: ({ content }: { content: string }) => <>{renderBlocks(content)}</>,
}));

// The component is imported after the mock so it sees the stub renderer.
import { CommentComposer, CommentRail } from "../components/CommentRail";
import { DiagnosticsDialog } from "../components/DiagnosticsDialog";
import { PlanDocument, type AnchorMap } from "../components/PlanDocument";
import { ReviewFooter } from "../components/ReviewFooter";
import { useReviewDraft } from "../hooks/useReviewDraft";
import { collectDiagnostics, formatDiagnostics } from "../lib/diagnostics";

function renderBlocks(content: string) {
  return content.split(/\n\s*\n/).map((block, index) => {
    if (block.startsWith("# ")) return <h2 key={index}>{block.slice(2)}</h2>;
    if (block.startsWith("```")) {
      const code = block.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
      return (
        <pre key={index}>
          <button type="button">Copy</button>
          <code>{code}</code>
        </pre>
      );
    }
    if (block.startsWith("- ")) {
      return (
        <ul key={index}>
          {block.split("\n").map((line, item) => (
            <li key={item}>{line.slice(2)}</li>
          ))}
        </ul>
      );
    }
    return <p key={index}>{block}</p>;
  });
}

/* ---------- browser API stubs jsdom does not provide ---------- */

class FakeHighlight {
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
  add(range: Range) {
    this.ranges.push(range);
  }
  clear() {
    this.ranges = [];
  }
}
const highlightRegistry = new Map<string, FakeHighlight>();

function paintedQuotes(name = HIGHLIGHT_NAME): string[] {
  return (highlightRegistry.get(name)?.ranges ?? []).map((range) => range.toString());
}

let caretTarget: { node: Node; offset: number } | null = null;

beforeEach(() => {
  highlightRegistry.clear();
  caretTarget = null;
  window.localStorage.clear();
  Object.assign(globalThis, {
    CSS: { highlights: highlightRegistry },
    Highlight: FakeHighlight,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes("coarse") && coarsePointer,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  Object.assign(document, {
    caretPositionFromPoint: () =>
      caretTarget ? { offsetNode: caretTarget.node, offset: caretTarget.offset } : null,
  });
  if (typeof Element.prototype.scrollTo !== "function") {
    Element.prototype.scrollTo = function scrollTo() {} as Element["scrollTo"];
  }
  if (typeof Range.prototype.getBoundingClientRect !== "function") {
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
  }
});

let coarsePointer = false;

afterEach(() => {
  cleanup();
  coarsePointer = false;
  document.getSelection()?.removeAllRanges();
});

/* ---------- helpers that act like a reviewer ---------- */

function textNodeContaining(root: Node, needle: string): { node: Text; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current: Node | null = walker.nextNode();
  while (current !== null) {
    const offset = (current as Text).data.indexOf(needle);
    if (offset >= 0) return { node: current as Text, offset };
    current = walker.nextNode();
  }
  throw new Error(`No text node contains "${needle}"`);
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Selects from the start of `from` to the end of `to`, like a mouse drag. */
async function selectText(root: Node, from: string, to: string = from) {
  const start = textNodeContaining(root, from);
  const end = textNodeContaining(root, to);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + to.length);
  await act(async () => {
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await nextFrame();
  });
}

async function clearSelection() {
  await act(async () => {
    document.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    await nextFrame();
  });
}

function comment(overrides: Partial<PlanComment> & { quote: string }): PlanComment {
  return commentSchema.parse({
    id: `c-${overrides.quote.slice(0, 8)}`,
    versionId: "v1",
    body: "Look at this.",
    createdAt: 1,
    sentAt: null,
    ...overrides,
  });
}

function renderDocument(props: Partial<ComponentProps<typeof PlanDocument>> & { markdown: string }) {
  const onQuote = vi.fn();
  const onActivateComment = vi.fn();
  const onAnchorsChange = vi.fn();
  const onPendingMatch = vi.fn();
  const view = render(
    <PlanDocument
      versionId="v1"
      comments={[]}
      activeCommentId={null}
      canComment
      pendingQuote={null}
      onQuote={onQuote}
      onActivateComment={onActivateComment}
      onAnchorsChange={onAnchorsChange}
      onPendingMatch={onPendingMatch}
      {...props}
    />,
  );
  const content = () => view.container.querySelector(".plans-document")!;
  const lastAnchors = (): AnchorMap => onAnchorsChange.mock.calls.at(-1)?.[0] ?? {};
  return { ...view, onQuote, onActivateComment, onAnchorsChange, onPendingMatch, content, lastAnchors };
}

const commentButton = () => screen.getByRole("button", { name: /^comment/i });

/* ---------- 1. quotes that cross a block boundary ---------- */

describe("quotes across block boundaries", () => {
  it("lets a reviewer comment on a heading together with the paragraph below it", async () => {
    const { onQuote, content } = renderDocument({ markdown: "# Plan\n\nRun the tests." });

    await selectText(content(), "Plan", "the tests");
    fireEvent.pointerDown(commentButton());

    expect(onQuote).toHaveBeenCalledTimes(1);
    const quote: string = onQuote.mock.calls[0]![0];
    // The quote reads like the page: one space where the heading ends.
    expect(quote).toBe("Plan Run the tests");
  });

  it("highlights a saved comment whose quote spans a heading and a paragraph", () => {
    const saved = comment({ quote: "Plan Run the tests." });
    const { lastAnchors } = renderDocument({
      markdown: "# Plan\n\nRun the tests.",
      comments: [saved],
    });

    expect(lastAnchors()[saved.id]?.kind).toBe("unique");
    expect(paintedQuotes()).toEqual(["PlanRun the tests."]);
  });

  it("pins a repeated passage to the place it was selected, and stays unpainted without context", () => {
    const markdown = "Leave a comment, a redline, and a Looks good.\n\nStrike through redline quotes.\n\nRedline and Looks good read as badges.";
    const bare = comment({ quote: "redline", kind: "redline" });
    const pinned = comment({ id: "pinned", quote: "redline", kind: "redline", prefix: "Strike through ", suffix: " quotes." });
    const { lastAnchors } = renderDocument({ markdown, comments: [bare, pinned] });

    expect(lastAnchors()[bare.id]).toEqual({ kind: "ambiguous", count: 2 });
    const match = lastAnchors().pinned;
    expect(match?.kind).toBe("unique");
    expect(match?.kind === "unique" && markdown.replace(/\n+/g, " ").slice(match.start - 15, match.end)).toBe("Strike through redline");
    expect(paintedQuotes("plans-redline")).toEqual(["redline"]);
  });

  it("uses the recorded position for identical repeats, and ignores a stale one", () => {
    const markdown = "- Ship it\n- Tell the team\n\n- Ship it\n- Tell the team";
    const second = comment({ id: "second", quote: "Ship it", position: "Ship it Tell the team ".length });
    const stale = comment({ id: "stale", quote: "Ship it", position: 3 });
    const { lastAnchors } = renderDocument({ markdown, comments: [second, stale] });

    expect(lastAnchors().second).toEqual({ kind: "unique", start: 22, end: 29 });
    expect(lastAnchors().stale).toEqual({ kind: "ambiguous", count: 2 });
  });

  it("does not anchor a word that only exists by gluing two blocks together", () => {
    const glued = comment({ quote: "theme" });
    const { lastAnchors } = renderDocument({
      markdown: "Read the\n\nme is fine",
      comments: [glued],
    });

    expect(lastAnchors()[glued.id]?.kind).toBe("missing");
    expect(paintedQuotes()).toEqual([]);
  });

  it("anchors a quote that spans consecutive list items", () => {
    const saved = comment({ quote: "Ship it Tell the team" });
    const { lastAnchors } = renderDocument({
      markdown: "- Ship it\n- Tell the team",
      comments: [saved],
    });

    expect(lastAnchors()[saved.id]?.kind).toBe("unique");
    expect(paintedQuotes()).toEqual(["Ship itTell the team"]);
  });

  it("leaves renderer chrome such as a code block's Copy button out of the quote", async () => {
    const { onQuote, content } = renderDocument({
      markdown: "Then run:\n\n```sh\nnpm test\n```",
    });

    await selectText(content(), "Then run", "npm test");
    fireEvent.pointerDown(commentButton());

    expect(onQuote).toHaveBeenCalledWith("Then run: npm test", expect.any(Object));
  });
});

/* ---------- 2. duplicate and overlapping passages ---------- */

describe("duplicate passages", () => {
  it("reports how often a repeated passage appears and paints nothing for it", () => {
    const repeated = comment({ id: "dup", quote: "Run the tests." });
    const single = comment({ id: "one", quote: "Ship it" });
    const { lastAnchors } = renderDocument({
      markdown: "# Phase 1\n\nRun the tests.\n\n# Phase 2\n\nRun the tests.\n\nShip it",
      comments: [repeated, single],
    });

    expect(lastAnchors()["dup"]).toEqual({ kind: "ambiguous", count: 2 });
    expect(lastAnchors()["one"]?.kind).toBe("unique");
    // Only the unique comment gets a highlight; the reviewer must not see a
    // guessed location for the duplicate.
    expect(paintedQuotes()).toEqual(["Ship it"]);
  });

  it("treats a self-overlapping passage as ambiguous rather than picking the first hit", () => {
    const overlapping = comment({ id: "na", quote: "na na" });
    const { lastAnchors } = renderDocument({
      markdown: "Sing na na na with me",
      comments: [overlapping],
    });

    expect(lastAnchors()["na"]?.kind).toBe("ambiguous");
    expect(paintedQuotes()).toEqual([]);
  });

  it("tells the composer before saving when the pending quote is not unique", () => {
    const { onPendingMatch } = renderDocument({
      markdown: "Run the tests.\n\nRun the tests.",
      pendingQuote: "Run the tests.",
    });

    const reported: QuoteMatch | null = onPendingMatch.mock.calls.at(-1)?.[0] ?? null;
    expect(reported).toEqual({ kind: "ambiguous", count: 2 });
  });
});

/* ---------- 3. callback and render stability ---------- */

describe("render stability", () => {
  it("settles when the parent passes fresh comment arrays and inline callbacks", () => {
    const plan: Plan = planSchema.parse({
      id: "plan-1",
      title: "A plan",
      threadId: null,
      projectId: null,
      projectName: null,
      status: "review",
      sample: true,
      createdAt: 1,
      updatedAt: 1,
      versions: [{ id: "v1", number: 1, markdown: "Keep the existing data.", createdAt: 1 }],
      comments: [comment({ id: "keep", quote: "existing data" })],
    });
    let renders = 0;

    function Parent() {
      const [anchors, setAnchors] = useState<AnchorMap>({});
      renders += 1;
      return (
        <>
          <PlanDocument
            markdown={plan.versions[0]!.markdown}
            comments={commentsForVersion(plan, "v1")}
            activeCommentId={null}
            canComment
            pendingQuote={null}
            onQuote={() => {}}
            onActivateComment={() => {}}
            onAnchorsChange={(next) => setAnchors(next)}
            onPendingMatch={() => {}}
          />
          <output data-testid="anchors">{JSON.stringify(anchors)}</output>
        </>
      );
    }

    render(<Parent />);

    expect(JSON.parse(screen.getByTestId("anchors").textContent ?? "{}")).toEqual({
      keep: { kind: "unique", start: 9, end: 22 },
    });
    expect(renders).toBeLessThan(10);
  });
});

/* ---------- 4. clicking a highlight vs. dragging a new selection ---------- */

describe("activating a comment from the document", () => {
  it("shows actions only after the selection drag ends, including release outside the document", async () => {
    const { content } = renderDocument({ markdown: "Keep the existing data." });
    fireEvent.pointerDown(screen.getByText("Keep the existing data."));
    await selectText(content(), "existing");
    expect(screen.queryByRole("toolbar", { name: "Annotate selection" })).toBeNull();
    await selectText(content(), "existing data");
    expect(screen.queryByRole("toolbar", { name: "Annotate selection" })).toBeNull();
    await act(async () => { fireEvent.pointerUp(document.body); await nextFrame(); });
    expect(commentButton()).toBeTruthy();
    fireEvent.pointerDown(screen.getByText("Keep the existing data."));
    expect(screen.queryByRole("toolbar", { name: "Annotate selection" })).toBeNull();
    await act(async () => { fireEvent.pointerCancel(document.body); await nextFrame(); });
    expect(commentButton()).toBeTruthy();
  });

  it("shows actions for a touch selection even though iOS sends no pointerup", async () => {
    coarsePointer = true;
    const { content } = renderDocument({ markdown: "Keep the existing data.", onAnnotate: vi.fn(async () => {}) });
    // jsdom has no PointerEvent, so pointerType is attached by hand.
    const touchDown = Object.assign(new Event("pointerdown", { bubbles: true }), { pointerType: "touch" });
    act(() => { screen.getByText("Keep the existing data.").dispatchEvent(touchDown); });
    await selectText(content(), "existing data");
    expect(screen.getByRole("toolbar", { name: "Annotate selection" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Redline" })).toBeTruthy();
  });

  it("copies the selected text from the desktop menu", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { content, onQuote } = renderDocument({ markdown: "Keep the existing data." });
    await selectText(content(), "existing data");
    fireEvent.pointerDown(screen.getByRole("button", { name: /^Copy/ }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith("existing data");
    expect(onQuote).not.toHaveBeenCalled();
  });

  it("leaves Copy to the system callout on touch", async () => {
    coarsePointer = true;
    const { content } = renderDocument({ markdown: "Keep the existing data.", onAnnotate: vi.fn(async () => {}) });
    await selectText(content(), "existing data");
    const bar = screen.getByRole("toolbar", { name: "Annotate selection" });
    expect(within(bar).getAllByRole("button").map((button) => button.textContent)).toEqual(["Comment", "Ask", "Redline", "Looks good"]);
  });

  const saved = comment({ id: "keep", quote: "existing data" });
  const markdown = "Keep the existing data.\n\nDrop the cache.";

  it("activates the comment when the reviewer clicks its highlighted passage", () => {
    const { onActivateComment, content } = renderDocument({ markdown, comments: [saved] });
    caretTarget = textNodeContaining(content(), "existing");
    caretTarget.offset += 2;

    fireEvent.click(screen.getByText(/Keep the existing data/), { clientX: 10, clientY: 10 });

    expect(onActivateComment).toHaveBeenCalledWith("keep");
  });

  it("reports the comment under the pointer and shows what it says", async () => {
    const onHoverComment = vi.fn();
    const { content, rerender } = renderDocument({
      markdown,
      comments: [{ ...saved, body: "Keep this, it is load-bearing." }],
      onHoverComment,
    });
    caretTarget = textNodeContaining(content(), "existing");
    caretTarget.offset += 2;

    fireEvent.pointerMove(screen.getByText(/Keep the existing data/), { clientX: 10, clientY: 10, pointerType: "mouse" });
    await act(nextFrame);
    expect(onHoverComment).toHaveBeenLastCalledWith("keep");

    // jsdom has no layout; give the passage a box so the tooltip can be placed.
    const rect = { top: 40, left: 20, width: 80, height: 16, bottom: 56, right: 100, x: 20, y: 40, toJSON() {} } as DOMRect;
    const boundsSpy = vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(rect);
    Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
    const rectsSpy = vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([rect] as unknown as DOMRectList);
    rerender(
      <PlanDocument
        markdown={markdown}
        comments={[{ ...saved, body: "Keep this, it is load-bearing." }]}
        activeCommentId={null}
        hoveredCommentId="keep"
        onHoverComment={onHoverComment}
        canComment
        pendingQuote={null}
        onQuote={vi.fn()}
        onActivateComment={vi.fn()}
        onAnchorsChange={vi.fn()}
        onPendingMatch={vi.fn()}
      />,
    );
    expect(screen.getByRole("tooltip").textContent).toContain("Keep this, it is load-bearing.");
    expect(paintedQuotes(ACTIVE_HIGHLIGHT_NAME)).toEqual(["existing data"]);
    expect(paintedQuotes()).toEqual([]);
    boundsSpy.mockRestore();
    rectsSpy.mockRestore();

    fireEvent.pointerLeave(content().firstElementChild!);
    expect(onHoverComment).toHaveBeenLastCalledWith(null);
  });

  it("paints a rail-hovered redline in its emphasized tier without a tooltip", () => {
    renderDocument({
      markdown,
      comments: [comment({ id: "cut", quote: "the cache", kind: "redline" })],
      hoveredCommentId: "cut",
    });
    expect(paintedQuotes("plans-redline-active")).toEqual(["the cache"]);
    expect(paintedQuotes("plans-redline")).toEqual([]);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("does not jump to an old comment when a drag-select ends over its highlight", async () => {
    const { onActivateComment, content } = renderDocument({ markdown, comments: [saved] });
    await selectText(content(), "Keep the", "Drop the cache");
    caretTarget = textNodeContaining(content(), "existing");

    fireEvent.click(screen.getByText(/Keep the existing data/), { clientX: 10, clientY: 10 });

    expect(onActivateComment).not.toHaveBeenCalled();
    // The new selection is still offered for a comment.
    expect(commentButton()).toBeTruthy();
  });
});

/* ---------- 5. drafts survive a quick navigation ---------- */

describe("review drafts", () => {
  it("keeps the pending comment when the reviewer leaves before the debounce fires", () => {
    const { result, unmount } = renderHook(() => useReviewDraft("plan-1", "v1"));

    act(() => result.current.update({ pendingComment: { quote: "schedules", body: "Keep the schedules too.", kind: "ask" } }));
    unmount();

    expect(readDraft("plan-1", "v1").pendingComment?.body).toBe("Keep the schedules too.");
  });

  it("keeps the pending comment when the page is hidden right after typing", () => {
    const { result } = renderHook(() => useReviewDraft("plan-1", "v1"));

    act(() => result.current.update({ pendingComment: { quote: "scope", body: "Half a thought" } }));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(readDraft("plan-1", "v1").pendingComment?.body).toBe("Half a thought");
  });

  it("does not let a version switch drop the comment typed on the previous version", () => {
    const { result, rerender } = renderHook(({ version }) => useReviewDraft("plan-1", version), {
      initialProps: { version: "v1" },
    });

    act(() => result.current.update({ pendingComment: { quote: "scope", body: "About v1" } }));
    rerender({ version: "v2" });

    expect(readDraft("plan-1", "v1").pendingComment?.body).toBe("About v1");
    expect(result.current.draft.pendingComment).toMatchObject({ quote: "scope", body: "About v1", versionId: "v1" });
    expect(readDraft("plan-1", "v2").pendingComment?.body).toBe("About v1");
  });
});

/* ---------- 6. keyboard and touch paths to "Comment" ---------- */

describe("commenting without a mouse", () => {
  it("commits a keyboard selection with the c shortcut", async () => {
    const { onQuote, content } = renderDocument({ markdown: "Keep the existing data." });

    await selectText(content(), "existing data");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "c" });

    expect(onQuote).toHaveBeenCalledWith("existing data", { prefix: "Keep the ", suffix: ".", position: 9 });
  });

  it("offers a focusable Comment button that commits on Enter", async () => {
    const { onQuote, content } = renderDocument({ markdown: "Keep the existing data." });

    await selectText(content(), "existing data");
    const button = commentButton();
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: "Enter" });

    expect(onQuote).toHaveBeenCalledWith("existing data", { prefix: "Keep the ", suffix: ".", position: 9 });
  });

  it("ignores the shortcut while the reviewer types in a text field", async () => {
    const { onQuote, content } = renderDocument({ markdown: "Keep the existing data." });
    const input = document.createElement("textarea");
    document.body.append(input);

    await selectText(content(), "existing data");
    input.focus();
    fireEvent.keyDown(input, { key: "c" });

    expect(onQuote).not.toHaveBeenCalled();
    input.remove();
  });

  it("commits from the touch bar on pointer down, before the tap collapses the selection", async () => {
    coarsePointer = true;
    const { onQuote, content } = renderDocument({ markdown: "Keep the existing data." });

    await selectText(content(), "existing data");
    const bar = screen.getByRole("button", { name: /^comment/i });
    fireEvent.pointerDown(bar);
    // iOS collapses the selection on touchend; no click ever reaches the bar.
    await clearSelection();

    expect(onQuote).toHaveBeenCalledWith("existing data", { prefix: "Keep the ", suffix: ".", position: 9 });
  });
});

/* ---------- 7. oversize selections are refused, not truncated ---------- */

describe("oversize selections", () => {
  it("refuses a selection above the limit and says why", async () => {
    const long = "word ".repeat(MAX_QUOTE_LENGTH / 5 + 20).trim();
    const { onQuote, content } = renderDocument({ markdown: `Intro.\n\n${long}\n\nOutro.` });

    await selectText(content(), "Intro", "Outro");
    expect(screen.getByRole("status").textContent).toMatch(/selection too long/i);
    expect(screen.queryByRole("button", { name: /^comment/i })).toBeNull();
    fireEvent.keyDown(document.body, { key: "c" });

    expect(onQuote).not.toHaveBeenCalled();
  });
});


describe("selection annotation actions", () => {
  it.each(["redline", "looksGood"] as const)("saves %s directly from the selection toolbar", async (kind) => {
    const onAnnotate = vi.fn(async () => {});
    const { content, onQuote } = renderDocument({ markdown: "Keep the existing data.", onAnnotate });
    await selectText(content(), "existing data");
    fireEvent.pointerDown(screen.getByRole("button", { name: kind === "redline" ? /^Redline/ : /^Looks good/ }));
    expect(onAnnotate).toHaveBeenCalledWith("existing data", kind, { prefix: "Keep the ", suffix: ".", position: 9 });
    expect(onQuote).not.toHaveBeenCalled();
  });
});


it("keeps the comment composer free of quote and ambiguity callouts", () => {
  render(<CommentComposer pending={{ quote: "Limit", body: "" }} match={{ kind: "ambiguous", count: 3 }} onChange={vi.fn()} onCancel={vi.fn()} onSubmit={vi.fn(async () => {})} />);
  expect(screen.getByRole("textbox", { name: "Comment" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add comment" })).toBeTruthy();
  expect(screen.queryByText("Limit")).toBeNull();
  expect(screen.queryByText(/appears 3 times/)).toBeNull();
});


it.each([["d", "redline"], ["g", "looksGood"]] as const)("supports the %s selection shortcut", async (key, kind) => {
  const onAnnotate = vi.fn(async () => {});
  const { content } = renderDocument({ markdown: "Keep the existing data.", onAnnotate });
  await selectText(content(), "existing data");
  fireEvent.keyDown(document.body, { key });
  expect(onAnnotate).toHaveBeenCalledWith("existing data", kind, { prefix: "Keep the ", suffix: ".", position: 9 });
});

it("hides shortcut labels on the touch menu", async () => {
  coarsePointer = true;
  const { content, container } = renderDocument({ markdown: "Keep the existing data.", onAnnotate: vi.fn(async () => {}) });
  await selectText(content(), "existing data");
  expect(container.querySelectorAll("kbd")).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Redline" })).toBeTruthy();
});

/* ---------- the host's mobile panel shell ---------- */

describe("inside BB's select-none panel shell", () => {
  // BB wraps the mobile secondary panel in `select-none`. WebKit then refuses
  // both text selection and custom-highlight painting for the whole subtree,
  // which is why the phone showed no highlights and no annotate bar.
  it("opts the document back into text selection", () => {
    const { content } = renderDocument({ markdown: "Keep the existing data." });
    expect(content().classList.contains("select-text")).toBe(true);
  });

  it("shows the open count beside approval without a note or feedback step", () => {
    const plan = planSchema.parse({
      id: "plan-1", title: "A plan", threadId: null, projectId: null, projectName: null, status: "open", sample: true,
      createdAt: 1, updatedAt: 1, versions: [{ id: "v1", number: 1, markdown: "Keep the existing data.", createdAt: 1 }], comments: [],
    });
    render(<ReviewFooter plan={plan} failedCount={0} submitting={null} failure={null}
      onSubmit={vi.fn()} onDismissFailure={vi.fn()} confirmOpen={false} onConfirmOpenChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("No open annotations");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("reports a blocked selection and unpainted anchors in the diagnostics", () => {
    const host = document.createElement("div");
    host.style.userSelect = "none";
    const doc = document.createElement("div");
    doc.className = "plans-document";
    host.append(doc);
    document.body.append(host);
    const anchors: AnchorMap = { a: { kind: "unique", start: 0, end: 4 }, b: { kind: "ambiguous", count: 2 }, c: { kind: "missing" } };
    const report = collectDiagnostics(doc, anchors);
    expect(report).toMatchObject({ highlightApi: true, anchored: 1, ambiguous: 1, missing: 1, painted: 0, userSelect: "none" });
    const text = formatDiagnostics(report);
    expect(text).toContain("Text selection: none (The host sets user-select: none here");
    expect(text).toContain("Painted: 0 ranges (Fewer ranges painted than resolved.)");
    host.remove();
  });

  it("opens a copyable diagnostics dialog", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<DiagnosticsDialog open onOpenChange={vi.fn()} root={null} anchors={{}} />);
    expect(screen.getByRole("dialog", { name: "Diagnostics" })).toBeTruthy();
    expect(screen.getByText("Highlight API")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toMatch(/^Highlight API: available\nAnchors: 0 resolved/);
  });
});

it.each(["Send", "Control+Enter"])("keeps a failed reply for retry with %s", async (submit) => {
  const reply = vi.fn().mockRejectedValueOnce(new Error("Could not send reply")).mockResolvedValue(undefined);
  const annotation = commentSchema.parse({ id: "a", number: 1, versionId: "v1", quote: "A passage", body: "Explain this", createdAt: 1 });
  render(<CommentRail comments={[annotation]} anchors={{}} activeCommentId={null} onActivate={vi.fn()}
    actions={{ update: vi.fn(), remove: vi.fn(), resolve: vi.fn(), reply }} canEdit pending={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  const field = screen.getByRole("textbox", { name: "Reply to #1" });
  fireEvent.change(field, { target: { value: "  Please explain.  " } });
  const send = () => submit === "Send"
    ? fireEvent.click(screen.getByRole("button", { name: "Send" }))
    : fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
  await act(async () => { send(); });
  expect(screen.getByRole("alert").textContent).toBe("Could not send reply");
  expect((field as HTMLTextAreaElement).value).toBe("  Please explain.  ");
  await act(async () => { send(); });
  expect(reply).toHaveBeenLastCalledWith("a", "Please explain.");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reply" }));
});


it.each([false, true])("opens Ask from the selection menu with touch=%s", async (touch) => {
  coarsePointer = touch;
  const { content, onQuote } = renderDocument({ markdown: "Keep the existing data." });
  await selectText(content(), "existing data");
  fireEvent.pointerDown(screen.getByRole("button", { name: /^Ask/ }));
  expect(onQuote).toHaveBeenCalledWith("existing data", expect.any(Object), "ask");
});

it("opens Ask with the a shortcut", async () => {
  const { content, onQuote } = renderDocument({ markdown: "Keep the existing data." });
  await selectText(content(), "existing data");
  fireEvent.keyDown(document, { key: "a" });
  expect(onQuote).toHaveBeenCalledWith("existing data", expect.any(Object), "ask");
});

it("paints asks in both highlight tiers and leaves withdrawn quotes unpainted", () => {
  const annotations = [comment({ id: "ask", quote: "existing data", kind: "ask" }), comment({ id: "gone", quote: "Keep", state: "withdrawn" })];
  const view = renderDocument({ markdown: "Keep the existing data.", comments: annotations });
  expect(paintedQuotes("plans-ask")).toEqual(["existing data"]);
  expect(paintedQuotes()).toEqual([]);
  view.rerender(<PlanDocument markdown="Keep the existing data." comments={annotations} activeCommentId="ask" canComment
    pendingQuote={null} onQuote={vi.fn()} onActivateComment={vi.fn()} onAnchorsChange={vi.fn()} onPendingMatch={vi.fn()} />);
  expect(paintedQuotes("plans-ask-active")).toEqual(["existing data"]);
  expect(paintedQuotes("plans-ask")).toEqual([]);
});

it("anchors a repeated quote by context when equal-length paragraphs swap versions", () => {
  const first = "Alpha: shared quote, first.";
  const second = "Bravo: shared quote, other.";
  expect(first.length).toBe(second.length);
  const saved = comment({ id: "moved", quote: "shared quote", prefix: "Alpha: ", suffix: ", first.", position: 7 });
  const props = { comments: [saved], activeCommentId: null, canComment: true, pendingQuote: null,
    onQuote: vi.fn(), onActivateComment: vi.fn(), onAnchorsChange: vi.fn(), onPendingMatch: vi.fn() };
  const view = render(<PlanDocument {...props} versionId="v1" markdown={`${first}\n\n${second}`} />);
  expect(highlightRegistry.get(HIGHLIGHT_NAME)?.ranges[0]?.startContainer.textContent).toBe(first);
  view.rerender(<PlanDocument {...props} versionId="v2" markdown={`${second}\n\n${first}`} />);
  expect(highlightRegistry.get(HIGHLIGHT_NAME)?.ranges[0]?.startContainer.textContent).toBe(first);
  expect(props.onAnchorsChange).toHaveBeenLastCalledWith({ moved: { kind: "unique", start: second.length + 8, end: second.length + 20 } });
});

it("returns focus to Approve after cancelling its dialog", async () => {
  const plan = planSchema.parse({ id: "p", title: "Plan", threadId: null, projectId: null, projectName: null, status: "open", createdAt: 1, updatedAt: 1,
    versions: [{ id: "v1", number: 1, markdown: "Plan", createdAt: 1 }] });
  function Footer() {
    const [open, setOpen] = useState(false);
    return <ReviewFooter plan={plan} failedCount={0} submitting={null} failure={null}
      onSubmit={vi.fn()} onDismissFailure={vi.fn()} confirmOpen={open} onConfirmOpenChange={setOpen} />;
  }
  render(<Footer />);
  const approve = screen.getByRole("button", { name: "Approve" });
  fireEvent.click(approve);
  const dialog = screen.getByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(document.activeElement).toBe(approve);
});
