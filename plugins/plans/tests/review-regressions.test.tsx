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
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plan, PlanComment } from "../contract";
import { readDraft } from "../lib/draft-store";
import { HIGHLIGHT_NAME } from "../lib/highlight-registry";
import { commentsForVersion } from "../lib/plan-model";
import { MAX_QUOTE_LENGTH, type QuoteMatch } from "../lib/quote-anchor";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  Markdown: ({ content }: { content: string }) => <>{renderBlocks(content)}</>,
}));

// The component is imported after the mock so it sees the stub renderer.
import { CommentComposer } from "../components/CommentRail";
import { PlanDocument, type AnchorMap } from "../components/PlanDocument";
import { useReviewDraft } from "../hooks/useReviewDraft";

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
  return {
    id: `c-${overrides.quote.slice(0, 8)}`,
    versionId: "v1",
    body: "Look at this.",
    resolved: false,
    createdAt: 1,
    sentAt: null,
    ...overrides,
  };
}

function renderDocument(props: Partial<ComponentProps<typeof PlanDocument>> & { markdown: string }) {
  const onQuote = vi.fn();
  const onActivateComment = vi.fn();
  const onAnchorsChange = vi.fn();
  const onPendingMatch = vi.fn();
  const view = render(
    <PlanDocument
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

    expect(onQuote).toHaveBeenCalledWith("Then run: npm test");
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
    const plan: Plan = {
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
    };
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
  const saved = comment({ id: "keep", quote: "existing data" });
  const markdown = "Keep the existing data.\n\nDrop the cache.";

  it("activates the comment when the reviewer clicks its highlighted passage", () => {
    const { onActivateComment, content } = renderDocument({ markdown, comments: [saved] });
    caretTarget = textNodeContaining(content(), "existing");
    caretTarget.offset += 2;

    fireEvent.click(screen.getByText(/Keep the existing data/), { clientX: 10, clientY: 10 });

    expect(onActivateComment).toHaveBeenCalledWith("keep");
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
  it("keeps the note when the reviewer leaves before the debounce fires", () => {
    const { result, unmount } = renderHook(() => useReviewDraft("plan-1", "v1"));

    act(() => result.current.update({ note: "Keep the schedules too." }));
    unmount();

    expect(readDraft("plan-1", "v1").note).toBe("Keep the schedules too.");
  });

  it("keeps the note when the page is hidden right after typing", () => {
    const { result } = renderHook(() => useReviewDraft("plan-1", "v1"));

    act(() => result.current.update({ note: "Half a thought" }));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(readDraft("plan-1", "v1").note).toBe("Half a thought");
  });

  it("does not let a version switch drop the note typed on the previous version", () => {
    const { result, rerender } = renderHook(({ version }) => useReviewDraft("plan-1", version), {
      initialProps: { version: "v1" },
    });

    act(() => result.current.update({ note: "About v1" }));
    rerender({ version: "v2" });

    expect(readDraft("plan-1", "v1").note).toBe("About v1");
    expect(result.current.draft.note).toBe("");
  });
});

/* ---------- 6. keyboard and touch paths to "Comment" ---------- */

describe("commenting without a mouse", () => {
  it("commits a keyboard selection with the c shortcut", async () => {
    const { onQuote, content } = renderDocument({ markdown: "Keep the existing data." });

    await selectText(content(), "existing data");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "c" });

    expect(onQuote).toHaveBeenCalledWith("existing data");
  });

  it("offers a focusable Comment button that commits on Enter", async () => {
    const { onQuote, content } = renderDocument({ markdown: "Keep the existing data." });

    await selectText(content(), "existing data");
    const button = commentButton();
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: "Enter" });

    expect(onQuote).toHaveBeenCalledWith("existing data");
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

    expect(onQuote).toHaveBeenCalledWith("existing data");
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
    expect(onAnnotate).toHaveBeenCalledWith("existing data", kind);
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
  expect(onAnnotate).toHaveBeenCalledWith("existing data", kind);
});

it("hides shortcut labels on the touch menu", async () => {
  coarsePointer = true;
  const { content, container } = renderDocument({ markdown: "Keep the existing data.", onAnnotate: vi.fn(async () => {}) });
  await selectText(content(), "existing data");
  expect(container.querySelectorAll("kbd")).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Redline" })).toBeTruthy();
});
