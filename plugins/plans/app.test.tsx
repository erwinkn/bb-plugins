// @vitest-environment jsdom
/**
 * Slot-level tests through the SDK's frontend harness: the registrations
 * validate like the host, rpc is a recorded fake, and the flows below drive
 * the real components (list, create, annotations, live updates, approval).
 */
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ComponentType } from "react";
import {
  loadPluginApp,
  renderSlot,
  type RenderedSlot,
  type RenderSlotOptions,
} from "@get-bb/plugin-sdk/testing/app";
import { planSchema, commentSchema } from "./contract";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { Plan, PlanComment, PlanVersion, plansContract } from "./contract";

const app = await loadPluginApp(() => import("./app"));
const threadAction = app.threadPanelActions[0]!;

let now = 1_700_000_000_000;
function version(number: number, markdown = `# Plan\n\nStep ${number}.`): PlanVersion {
  return { id: `v${number}`, number, markdown, createdAt: now + number, source: "user", summary: "", resolves: [] };
}
function makePlan(overrides: Partial<Plan> = {}): Plan {
  return planSchema.parse({
    id: "plan-1",
    title: "Add rate limiting",
    threadId: "thr_1",
    projectId: "proj_1",
    projectName: "Demo",
    status: "open",
    sample: false,
    createdAt: now,
    updatedAt: now,
    versions: [version(1)],
    comments: [],
    ...overrides,
  });
}
function comment(overrides: Partial<PlanComment> = {}): PlanComment {
  return commentSchema.parse({
    id: "c1",
    versionId: "v1",
    quote: "Step 1.",
    body: "Reconsider this.",
    createdAt: now,
    deliveredAt: null,
    ...overrides,
  });
}

/** An in-memory backend good enough for the review flows. */
function fakeBackend(initial: Plan[]) {
  const plans = new Map(initial.map((plan) => [plan.id, structuredClone(plan)]));
  const get = (id: string) => {
    const plan = plans.get(id);
    if (!plan) throw new Error(`Plan ${id} not found`);
    return plan;
  };
  return {
    plans,
    rpc: {
      list: ({ threadId }: { threadId?: string; offset?: number }) =>
        [...plans.values()].filter((plan) => !threadId || plan.threadId === threadId),
      get: ({ id }: { id: string }) => get(id),
      create: (input: { title: string; markdown: string; threadId?: string; sample?: boolean }) => {
        const plan = makePlan({
          id: `plan-${plans.size + 1}`,
          title: input.title,
          threadId: input.threadId ?? null,
          projectName: input.threadId ? "Demo" : null,
          sample: input.sample === true,
          versions: [version(1, input.markdown)],
        });
        plans.set(plan.id, plan);
        return plan;
      },
      addAnnotation: ({ id, quote, body = "", kind, ...context }: { id: string; quote: string; body?: string; kind?: PlanComment["kind"] }) => {
        const plan = get(id);
        plan.comments.push(comment({ id: `c${plan.comments.length + 1}`, number: plan.comments.length + 1,
          versionId: plan.versions.at(-1)!.id, quote, body, kind, ...context }));
        return plan;
      },
      updateAnnotation: ({ id, annotationId, body }: { id: string; annotationId: string; body: string }) => {
        const plan = get(id);
        plan.comments.find((entry) => entry.id === annotationId)!.body = body;
        return plan;
      },
      withdrawAnnotation: ({ id, annotationId }: { id: string; annotationId: string }) => {
        const plan = get(id);
        plan.comments.find((entry) => entry.id === annotationId)!.state = "withdrawn";
        return plan;
      },
      resolveAnnotation: ({ id, annotationId }: { id: string; annotationId: string }) => {
        const plan = get(id);
        plan.comments.find((entry) => entry.id === annotationId)!.state = "addressed";
        return plan;
      },
      replyToAnnotation: ({ id, annotationId, body }: { id: string; annotationId: string; body: string }) => {
        const plan = get(id);
        plan.comments.find((entry) => entry.id === annotationId)!.replies.push({ id: "reply-1", author: "user", body, createdAt: now, deliveredAt: null });
        return plan;
      },
      approve: ({ id }: { id: string; requestId: string }) => {
        const plan = get(id); plan.status = "approved"; return plan;
      },
      setDeliveryMode: ({ id, mode }: { id: string; mode: Plan["deliveryMode"] }) => {
        const plan = get(id); plan.deliveryMode = mode; return plan;
      },
      deliveryStatus: () => [] as Array<{ id: string; kind: string; state: "pending" | "failed" | "dropped" | "cancelled" | "delivered"; attempts: number; nextAttemptAt: number }>,
      annotationDeliveryStatus: () => [] as Array<{ id: string; annotationId: string; kind: string; state: "pending" | "failed" | "dropped" | "cancelled" | "delivered"; attempts: number; nextAttemptAt: number }>,
      remove: ({ id }: { id: string }) => {
        plans.delete(id);
        return { ok: true as const };
      },
    },
  };
}

type Contract = typeof plansContract;
let slot: RenderedSlot | null = null;
function render<Props extends object>(
  registration: { component: ComponentType<Props> },
  props: Props,
  options: RenderSlotOptions<Contract>,
): RenderedSlot {
  return renderSlot<Props, Contract>(registration, props, options);
}
beforeEach(() => {
  // jsdom has no native top layer. nwsapi's :modal/:fullscreen fallback
  // recurses through Element.matches when Floating UI measures a menu.
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector) {
    if (selector === ":modal" || selector === ":fullscreen") return false;
    return matches.call(this, selector);
  });
  window.localStorage.clear();
  Element.prototype.scrollTo ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  if (typeof Range.prototype.getBoundingClientRect !== "function") {
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
  }
});
afterEach(async () => {
  await act(async () => { slot?.lifecycle.unmount(); });
  cleanup();
  slot = null;
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.useRealTimers();
}, 30000);

describe("registrations", () => {
  it("registers only the thread panel and header actions", () => {
    expect(app.navPanels).toHaveLength(0);
    expect(threadAction.id).toBe("review-plan");
    expect(app.threadHeaderActions).toHaveLength(1);
  });
});

describe("comments", () => {
  it("keeps matching new quotes while the document tab is hidden", async () => {
    const backend = fakeBackend([makePlan()]);
    slot = render(threadAction, { threadId: "thr_1", params: { planId: "plan-1" } }, { rpc: backend.rpc });
    fireEvent.keyDown(await slot.findByRole("combobox", { name: /Plan view:/ }), { key: "Enter" });

    fireEvent.keyDown(within(document.body).getByRole("option", { hidden: true, name: /Comments/ }), { key: "Enter" });

    backend.plans.get("plan-1")!.comments.push(
      comment({ id: "present" }),
      comment({ id: "missing", quote: "Absent passage", body: "Missing quote" }),
    );
    await slot.behavior.emitRealtime("plans-changed", { id: "plan-1" });
    await waitFor(() => expect(slot!.getAllByText("Text changed")).toHaveLength(1));
    expect(slot.getByRole("combobox", { name: "Plan view: Comments" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Show this passage in the plan" })).toBeTruthy();
  }, 15000);

  it("saves a pending comment that predates selection context without sending undefined fields", async () => {
    const backend = fakeBackend([makePlan()]);
    window.localStorage.setItem(
      "bb-plugin-plans:draft:plan-1:v1",
      JSON.stringify({ note: "", pendingComment: { quote: "Step 1.", body: "Older draft" } }),
    );
    slot = render(threadAction, { threadId: "thr_1", params: { planId: "plan-1" } }, { rpc: backend.rpc });
    fireEvent.click(await slot.findByRole("button", { name: "Add comment" }));
    await waitFor(() => expect(backend.plans.get("plan-1")?.comments).toHaveLength(1));
    const input = slot.inspection.rpcCalls.find((call) => call.method === "addAnnotation")?.input as Record<string, unknown>;
    expect(input).toMatchObject({ quote: "Step 1.", body: "Older draft" });
    expect(Object.keys(input)).not.toContain("prefix");
    expect(Object.values(input)).not.toContain(undefined);
  });

  it("keeps the selection context when the composer saves a pending comment", async () => {
    const backend = fakeBackend([makePlan()]);
    window.localStorage.setItem(
      "bb-plugin-plans:draft:plan-1:v1",
      JSON.stringify({ note: "", pendingComment: { quote: "Step 1.", body: "Pinned", prefix: "Plan ", suffix: "", position: 5 } }),
    );
    slot = render(threadAction, { threadId: "thr_1", params: { planId: "plan-1" } }, { rpc: backend.rpc });
    fireEvent.click(await slot.findByRole("button", { name: "Add comment" }));
    await waitFor(() => expect(backend.plans.get("plan-1")?.comments).toHaveLength(1));
    const input = slot.inspection.rpcCalls.find((call) => call.method === "addAnnotation")?.input;
    expect(input).toMatchObject({ quote: "Step 1.", body: "Pinned", prefix: "Plan ", suffix: "", position: 5 });
  });

  it("lets a draft comment be edited and deleted, but not a sent one", async () => {
    const backend = fakeBackend([
      makePlan({ comments: [comment({ id: "draft" }), comment({ id: "sent", body: "Already sent.", deliveredAt: now })] }),
    ]);
    slot = render(threadAction, { threadId: "thr_1", params: { planId: "plan-1" } }, { rpc: backend.rpc });
    fireEvent.keyDown(await slot.findByRole("combobox", { name: /Plan view:/ }), { key: "Enter" });

    fireEvent.keyDown(within(document.body).getByRole("option", { hidden: true, name: /Comments/ }), { key: "Enter" });

    expect(slot.queryByText("Text changed")).toBeNull();
    expect(slot.getAllByRole("button", { name: "Resolve" })).toHaveLength(2);
    expect(slot.getAllByRole("button", { name: "Edit comment" })).toHaveLength(1);
    fireEvent.click(slot.getByRole("button", { name: "Edit comment" }));
    fireEvent.change(slot.getByLabelText("Edit comment"), { target: { value: "Reworded." } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(backend.plans.get("plan-1")?.comments[0]?.body).toBe("Reworded."));
    fireEvent.click(slot.getByRole("button", { name: "Delete comment" }));
    await waitFor(() => expect(backend.plans.get("plan-1")?.comments[0]?.state).toBe("withdrawn"));
    expect(slot.getByText("Already sent.")).toBeTruthy();
  }, 15000);
});

describe("thread panel", () => {
  it("resets the chosen plan when a mounted panel switches threads", async () => {
    const backend = fakeBackend([makePlan()]);
    slot = render(threadAction, { threadId: "thr_1", params: { planId: "plan-1" } }, { rpc: backend.rpc });
    await slot.findByRole("button", { name: "Approve" });
    slot.lifecycle.rerender(createElement(threadAction.component, { threadId: "thr_empty", params: null }));
    await slot.findByLabelText("Plan Markdown");
    expect(slot.queryByText("This plan belongs to another thread")).toBeNull();
    expect(slot.queryByRole("button", { name: "Approve" })).toBeNull();
    slot.lifecycle.rerender(createElement(threadAction.component, { threadId: "thr_1", params: null }));
    await slot.findByRole("button", { name: "Approve" });
  });

  it("rejects a requested plan from another thread", async () => {
    const backend = fakeBackend([makePlan({ threadId: "thr_other" })]);
    slot = render(threadAction, { threadId: "thr_1", params: { planId: "plan-1" } }, { rpc: backend.rpc });
    await slot.findByText("This plan belongs to another thread");
    expect(slot.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(slot.queryByLabelText("Note for the agent")).toBeNull();
    expect(slot.queryByText("Add rate limiting")).toBeNull();
  });

  it("opens a requested plan beyond the first thread list page", async () => {
    const plan = makePlan();
    const backend = fakeBackend([plan]);
    slot = render(threadAction, { threadId: "thr_1", params: { planId: plan.id } }, {
      rpc: { ...backend.rpc, list: () => [] },
    });
    expect(await slot.findByRole("button", { name: "Approve" })).toBeTruthy();
    expect(slot.getByRole("heading", { name: plan.title })).toBeTruthy();
  });

  it("lists only this thread's plans and offers older pages", async () => {
    const many = Array.from({ length: 10 }, (_, index) => makePlan({ id: `plan-${index}`, title: `Plan ${index}` }));
    const backend = fakeBackend([...many, makePlan({ id: "other", threadId: "thr_other", title: "Other thread plan" })]);
    slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: backend.rpc });
    await slot.findByText("Plan 0");
    expect(slot.queryByText("Other thread plan")).toBeNull();
    expect(slot.getByRole("button", { name: "Load older plans" })).toBeTruthy();
    fireEvent.click(slot.getByText("Plan 0"));
    await slot.findByRole("button", { name: "Approve" });
    fireEvent.click(slot.getByRole("button", { name: "Back to plans" }));
    await slot.findByText("Plan 9");
  });

  it("shows the create form bound to the thread when it has no plan", async () => {
    const backend = fakeBackend([]);
    slot = render(threadAction, { threadId: "thr_9", params: null }, { rpc: backend.rpc });
    await slot.findByLabelText("Plan Markdown");
    expect(slot.queryByLabelText("Thread ID")).toBeNull();
    fireEvent.change(slot.getByLabelText("Plan Markdown"), { target: { value: "# From thread\n\nBody." } });
    fireEvent.click(slot.getByRole("button", { name: "Create plan" }));
    await waitFor(() => expect(backend.plans.size).toBe(1));
    expect([...backend.plans.values()][0]?.threadId).toBe("thr_9");
    await slot.findByRole("button", { name: "Approve" });
  });

  it("opens the thread's only plan straight into review", async () => {
    const backend = fakeBackend([makePlan({ threadId: "thr_9" }), makePlan({ id: "plan-2", threadId: "thr_other" })]);
    slot = render(threadAction, { threadId: "thr_9", params: null }, { rpc: backend.rpc });
    await slot.findByRole("button", { name: "Approve" });
    expect(slot.queryByText("plan-2")).toBeNull();
  });
});

async function showComments() {
  const trigger = await slot!.findByRole("combobox", { name: /Plan view:/ });
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.keyDown(within(document.body).getByRole("option", { hidden: true, name: /Comments/ }), { key: "Enter" });
  // Let Radix return focus before the next interaction takes it elsewhere.
  await waitFor(() => expect(document.activeElement).toBe(trigger));
}
async function showChanges() {
  fireEvent.keyDown(await slot!.findByRole("combobox", { name: /Plan view:/ }), { key: "Enter" });
  fireEvent.keyDown(within(document.body).getByRole("option", { hidden: true, name: "Changes" }), { key: "Enter" });
}
async function selectPassage() {
  const content = document.querySelector(".plans-document")!;
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && !node.textContent?.includes("Step 1.")) node = walker.nextNode();
  if (!node) throw new Error("Missing plan passage");
  const offset = node.textContent!.indexOf("Step 1.");
  const range = document.createRange();
  range.setStart(node, offset); range.setEnd(node, offset + 7);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  await slot!.findByRole("toolbar", { name: "Annotate selection" });
}

describe("live review", { timeout: 30000 }, () => {
  it.each(["comment", "ask", "redline", "looksGood"] as const)("adds a %s from the selected passage", async (kind) => {
    const backend = fakeBackend([makePlan()]);
    slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: backend.rpc });
    await slot.findByRole("button", { name: "Approve" });
    await selectPassage();
    const label = { comment: /^Comment/, ask: /^Ask/, redline: /^Redline/, looksGood: /^Looks good/ }[kind];
    fireEvent.pointerDown(slot.getByRole("button", { name: label }));
    if (kind === "comment" || kind === "ask") {
      const field = await slot.findByPlaceholderText(kind === "ask" ? "What do you want to know?" : "What should change here?");
      fireEvent.change(field, { target: { value: "Please explain this choice." } });
      fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    }
    await waitFor(() => expect(backend.plans.get("plan-1")!.comments).toHaveLength(1));
    expect(slot.inspection.rpcCalls.find((call) => call.method === "addAnnotation")?.input).toMatchObject({ id: "plan-1", quote: "Step 1.", kind });
    expect(backend.plans.get("plan-1")!.comments[0]!.state).toBe(kind === "looksGood" ? "addressed" : "open");
  });

  it("confirms approval with open annotations and reuses the request ID on retry", async () => {
    const backend = fakeBackend([makePlan({ comments: [comment({ number: 1 }), comment({ id: "c2", number: 2, kind: "ask" }), comment({ id: "c3", number: 3, kind: "redline" })] })]);
    let attempts = 0;
    slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: { ...backend.rpc, approve: (input) => {
      if (++attempts === 1) throw new Error("Connection lost");
      return backend.rpc.approve(input);
    } } });
    for (let attempt = 0; attempt < 2; attempt++) {
      fireEvent.click(await slot.findByRole("button", { name: "Approve" }));
      const dialog = await within(document.body).findByRole("alertdialog");
      expect(within(dialog).getByText("3 annotations are still open. The agent implements the current version.")).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
      if (attempt === 0) await slot.findByText("Connection lost");
    }
    await slot.findByText("Approved");
    const calls = slot.inspection.rpcCalls.filter((call) => call.method === "approve");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.input).toEqual(calls[1]!.input);
    expect(calls[0]!.input).toMatchObject({ id: "plan-1", requestId: expect.any(String), versionId: "v1" });
  });

  it("shows states in creation order, threads replies, and withdraws delivered annotations", async () => {
    const backend = fakeBackend([makePlan({ comments: [
      comment({ id: "pending", number: 1 }),
      comment({ id: "delivered", number: 2, deliveredAt: now }),
      comment({ id: "answered", number: 3, kind: "ask", state: "answered", deliveredAt: now,
        replies: [{ id: "r1", author: "agent", body: "It limits the scope.", createdAt: now, deliveredAt: now }] }),
      comment({ id: "addressed", number: 4, kind: "looksGood", state: "addressed" }),
      comment({ id: "withdrawn", number: 5, state: "withdrawn" }),
    ] })]);
    slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: backend.rpc });
    await showComments();
    const cards = document.querySelectorAll("article");
    expect([...cards].map((card) => card.textContent?.match(/#\d+/)?.[0])).toEqual(["#1", "#2", "#3", "#4", "#5"]);
    for (const label of ["Pending", "Delivered", "Answered", "Addressed", "Withdrawn", "Agent"]) expect(slot.getByText(label)).toBeTruthy();
    expect(within(cards[4] as HTMLElement).queryByRole("button", { name: /Delete|Withdraw|Resolve|Reply/ })).toBeNull();
    expect(within(cards[1] as HTMLElement).queryByRole("button", { name: "Edit comment" })).toBeNull();
    expect(slot.queryByLabelText("Reply to #3")).toBeNull();
    const replyButton = within(cards[2] as HTMLElement).getByRole("button", { name: "Reply" });
    fireEvent.click(replyButton);
    expect(document.activeElement).toBe(slot.getByLabelText("Reply to #3"));
    fireEvent.keyDown(slot.getByLabelText("Reply to #3"), { key: "Escape" });
    expect(slot.queryByLabelText("Reply to #3")).toBeNull();
    expect(document.activeElement).toBe(replyButton);
    fireEvent.click(replyButton);
    fireEvent.click(within(cards[2] as HTMLElement).getByRole("button", { name: "Cancel" }));
    expect(slot.queryByLabelText("Reply to #3")).toBeNull();
    expect(document.activeElement).toBe(replyButton);
    fireEvent.click(replyButton);
    fireEvent.change(slot.getByLabelText("Reply to #3"), { target: { value: "That answers it." } });
    fireEvent.keyDown(slot.getByLabelText("Reply to #3"), { key: "Enter", metaKey: true });
    await slot.findByText("You");
    expect(slot.getByText("That answers it.")).toBeTruthy();
    expect(slot.getByText("It limits the scope.")).toBeTruthy();
    expect(slot.queryByLabelText("Reply to #3")).toBeNull();
    expect(document.activeElement).toBe(replyButton);
    fireEvent.click(within(cards[1] as HTMLElement).getByRole("button", { name: "Withdraw comment" }));
    await waitFor(() => expect(backend.plans.get("plan-1")!.comments[1]!.state).toBe("withdrawn"));
    expect(slot.inspection.rpcCalls.find((call) => call.method === "withdrawAnnotation")?.input).toEqual({ id: "plan-1", annotationId: "delivered" });
  });

  it("matches delivery failures to the affected card and clears them on realtime updates", async () => {
    const backend = fakeBackend([makePlan({ comments: [comment({ number: 1 }), comment({ id: "c2", number: 2 })] })]);
    let failed = true;
    const item = { id: "outbox-1", annotationId: "c2", kind: "annotation", state: "failed" as const, attempts: 1, nextAttemptAt: now };
    slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: { ...backend.rpc,
      deliveryStatus: () => failed ? [item] : [], annotationDeliveryStatus: () => failed ? [item] : [],
    } });
    await showComments();
    const failure = await slot.findByText("Not delivered · retrying");
    expect(failure.closest("article")!.textContent).toContain("#2");
    expect(slot.getByText("2 open · 1 not delivered")).toBeTruthy();
    failed = false;
    await slot.behavior.emitRealtime("plans-changed", { id: "plan-1" });
    await waitFor(() => expect(slot!.queryByText("Not delivered · retrying")).toBeNull());
    expect(slot.getByText("2 open")).toBeTruthy();
  });

  it("labels annotations from a cancelled queued message without counting them as failures", async () => {
    const backend = fakeBackend([makePlan({ comments: [comment({ number: 1 })] })]);
    const item = { id: "outbox-1", annotationId: "c1", kind: "annotation", state: "cancelled" as const, attempts: 0, nextAttemptAt: now };
    slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: { ...backend.rpc, deliveryStatus: () => [item], annotationDeliveryStatus: () => [item] } });
    await showComments();
    const label = await slot.findByText("Not delivered · cancelled");
    expect(label.closest("article")!.textContent).toContain("#1");
    expect(slot.getByText("1 open")).toBeTruthy();
    expect(slot.queryByText(/not delivered$/)).toBeNull();
  });

  it("changes the delivery mode with checked menu items", async () => {
    const backend = fakeBackend([makePlan()]);
    slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: backend.rpc });
    fireEvent.keyDown(await slot.findByRole("button", { name: "Plan actions" }), { key: "Enter" });
    const menu = within(document.body);
    expect(menu.getByRole("menuitemradio", { hidden: true, name: "Queue after the current turn" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(menu.getByRole("menuitemradio", { hidden: true, name: "Steer into the running turn" }));
    await waitFor(() => expect(backend.plans.get("plan-1")!.deliveryMode).toBe("steer-if-active"));
    fireEvent.keyDown(slot.getByRole("button", { name: "Plan actions" }), { key: "Enter" });
    expect(menu.getByRole("menuitemradio", { hidden: true, name: "Steer into the running turn" }).getAttribute("aria-checked")).toBe("true");
    expect(menu.queryByRole("menuitem", { name: /revision/i })).toBeNull();
    fireEvent.keyDown(menu.getByRole("menuitemradio", { hidden: true, name: "Steer into the running turn" }), { key: "Escape" });
  });

  it("uses the last seen version as the changes base when reopened", async () => {
    window.localStorage.setItem("bb-plugin-plans:seen:plan-1", "v1");
    const backend = fakeBackend([makePlan({ versions: [version(1), version(2), version(3)] })]);
    slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: backend.rpc });
    await slot.findByRole("button", { name: "Approve" });
    expect(window.localStorage.getItem("bb-plugin-plans:seen:plan-1")).toBe("v3");
    await showChanges();
    expect(slot.getByRole("combobox", { name: "Base version" }).textContent).toBe("v1");
  });

  it("dismisses updates and clears them only after viewing the latest document", async () => {
    const backend = fakeBackend([makePlan()]);
    slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: backend.rpc });
    await showChanges();
    vi.useFakeTimers();
    const update = async (number: number) => {
      backend.plans.get("plan-1")!.versions.push({ ...version(number), source: "agent", summary: `Change ${number}` });
      await slot!.behavior.emitRealtime("plans-changed", { id: "plan-1" });
      expect(slot!.getByText(`Updated by the agent · v${number} · Change ${number}`)).toBeTruthy();
    };
    await update(2);
    fireEvent.click(slot.getByRole("button", { name: "Dismiss update" }));
    expect(slot.queryByText(/Updated by the agent/)).toBeNull();
    await update(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(slot.getByText(/Updated by the agent · v3/)).toBeTruthy();
    fireEvent.keyDown(slot.getByRole("combobox", { name: /Plan view:/ }), { key: "Enter" });
    fireEvent.keyDown(within(document.body).getByRole("option", { hidden: true, name: "Document" }), { key: "Enter" });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(slot.getByText(/Updated by the agent · v3/)).toBeTruthy();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(slot.getByText(/Updated by the agent · v3/)).toBeTruthy();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(slot.queryByText(/Updated by the agent/)).toBeNull();
    await update(4);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(slot.queryByText(/Updated by the agent/)).toBeNull();
  });

  it("follows agent updates, preserves the unseen diff base, and resolves changed text", async () => {
    const backend = fakeBackend([makePlan({ comments: [comment({ number: 1 })] })]);
    slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: backend.rpc });
    await showChanges();
    for (const number of [2, 3]) {
      backend.plans.get("plan-1")!.versions.push({ ...version(number), source: "agent", summary: `Applied change ${number}` });
      await slot.behavior.emitRealtime("plans-changed", { id: "plan-1" });
      await slot.findByText(`Updated by the agent · v${number} · Applied change ${number}`);
    }
    expect(window.localStorage.getItem("bb-plugin-plans:seen:plan-1")).toBe("v1");
    fireEvent.click(slot.getByRole("button", { name: "Show changes" }));
    expect(slot.queryByText(/Updated by the agent/)).toBeNull();
    expect(slot.getByRole("combobox", { name: "Base version" }).textContent).toBe("v1");
    await showComments();
    expect(slot.getByText("Text changed")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Resolve" }));
    await slot.findByText("Addressed");
    expect(backend.plans.get("plan-1")!.comments[0]!.state).toBe("addressed");
  });

  it("makes old versions read-only and shows only their annotations", async () => {
    const backend = fakeBackend([makePlan({ versions: [version(1), version(2)], comments: [comment({ number: 1 }), comment({ id: "c2", number: 2, versionId: "v2", quote: "Step 2." })] })]);
    slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: backend.rpc });
    fireEvent.keyDown(await slot.findByRole("combobox", { name: "Plan version" }), { key: "Enter" });
    fireEvent.keyDown(within(document.body).getByRole("option", { hidden: true, name: /^v1/ }), { key: "Enter" });
    await showComments();
    expect(document.querySelectorAll("article")).toHaveLength(1);
    expect(slot.queryByRole("button", { name: /Delete comment|Withdraw comment|Resolve|Approve/ })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Go to latest" }));
    await slot.findByRole("button", { name: "Approve" });
    expect(document.querySelectorAll("article")).toHaveLength(2);
  });
});

describe("thread status and prompt", () => {
  it.each([
    [true, "runtime", "Waiting for you"],
    [false, "waiting-for-input", "Waiting for you"],
    [false, "runtime", "Agent is working"],
    [false, "background-agent", "Agent is working"],
    [false, "working-draft", "Agent is working"],
  ] as const)("shows thread status for pending=%s and indicator=%s", async (pending, indicator, label) => {
    const backend = fakeBackend([makePlan()]);
    slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: backend.rpc, sidebarThreads: {
      threads: [{ id: "thr_1", hasPendingInteraction: pending, indicator } as PluginSidebarThread],
    } });
    await slot.findByText(`${label} · 0 open`);
  });

  it("shows live status in the header and opens the correct plan", async () => {
    const backend = fakeBackend([makePlan()]);
    slot = render(app.threadHeaderActions[0]!, { threadId: "thr_1", projectId: "proj_1", isCompactViewport: false }, { rpc: backend.rpc, sidebarThreads: {
      threads: [{ id: "thr_1", hasPendingInteraction: false, indicator: "runtime" } as PluginSidebarThread],
    } });
    fireEvent.click(await slot.findByRole("button", { name: "Plan: Agent is working" }));
    expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "openThreadPanel", options: expect.objectContaining({ params: { threadId: "thr_1", planId: "plan-1" } }) }));
  });

  it("keeps the prompt Open and Skip actions", async () => {
    let skipped = false;
    slot = render(app.pendingInteractions[0]!, {
      interaction: { id: "i1", threadId: "thr_1", title: "Review plan", createdAt: now, expiresAt: null,
        payload: { planId: "plan-1", versionId: "v1", title: "Plan", versionNumber: 1 } },
      submit: async () => {}, cancel: async () => { skipped = true; },
    }, { rpc: fakeBackend([]).rpc });
    expect(slot.getByText("Plan ready for your review.")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Open" }));
    expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "openThreadPanel", options: expect.objectContaining({ params: { threadId: "thr_1", planId: "plan-1" } }) }));
    fireEvent.click(slot.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(skipped).toBe(true));
  });
});

it("shows a delivery fallback notice once and keeps it dismissed on reopen", async () => {
  const backend = fakeBackend([makePlan({ delivery: { queuedMessageId: null, queuedUpdatedAt: null, itemIds: [], notice: "This provider queues feedback after the current turn." } })]);
  const props = { threadId: "thr_1", params: null };
  slot = render(threadAction, props, { rpc: backend.rpc });
  await slot.findByText("This provider queues feedback after the current turn.");
  fireEvent.click(slot.getByRole("button", { name: "Dismiss delivery notice" }));
  await slot.behavior.emitRealtime("plans-changed", { id: "plan-1" });
  expect(slot.queryByText("This provider queues feedback after the current turn.")).toBeNull();
  slot.lifecycle.unmount();
  slot = render(threadAction, props, { rpc: backend.rpc });
  await slot.findByRole("button", { name: "Approve" });
  expect(slot.queryByText("This provider queues feedback after the current turn.")).toBeNull();
});

it("shows approval delivery pending, failure and recovery from the delivery RPC", async () => {
  const backend = fakeBackend([makePlan()]);
  type Item = ReturnType<typeof backend.rpc.deliveryStatus>[number];
  let items: Item[] = [];
  slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: {
    ...backend.rpc, deliveryStatus: () => items,
    approve: (input) => {
      items = [{ id: "approval", kind: "approved", state: "pending", attempts: 0, nextAttemptAt: 0 }];
      return backend.rpc.approve(input);
    },
  } });
  fireEvent.click(await slot.findByRole("button", { name: "Approve" }));
  fireEvent.click(within(slot.getByRole("alertdialog")).getByRole("button", { name: "Approve" }));
  await slot.findByText("Sending approval…");
  expect(slot.queryByText("Approval sent to the thread")).toBeNull();
  items = [{ ...items[0]!, state: "failed", attempts: 1 }];
  await slot.behavior.emitRealtime("plans-changed", { id: "plan-1" });
  expect(slot.getByText("Approval not delivered · retrying")).toBeTruthy();
  expect(slot.getByText("1 not delivered")).toBeTruthy();
  // A separate failed event must remain visible after approval is delivered.
  items = [{ ...items[0]!, id: "reply", kind: "reply" }, { ...items[0]!, state: "delivered", attempts: 0 }];
  await slot.behavior.emitRealtime("plans-changed", { id: "plan-1" });
  expect(slot.getByText("Approval sent to the thread")).toBeTruthy();
  expect(slot.getByText("1 not delivered")).toBeTruthy();
  items = [];
  await slot.behavior.emitRealtime("plans-changed", { id: "plan-1" });
  expect(slot.queryByText("1 not delivered")).toBeNull();
});

it("shows the unseen agent version summary when the review reopens", async () => {
  window.localStorage.setItem("bb-plugin-plans:seen:plan-1", "v1");
  const backend = fakeBackend([makePlan({ versions: [version(1), version(2),
    { ...version(3), source: "agent", summary: "Reduced the scope" }] })]);
  slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: backend.rpc });
  await slot.findByText("Updated by the agent · v3 · Reduced the scope");
  fireEvent.click(slot.getByRole("button", { name: "Show changes" }));
  expect(slot.getByRole("combobox", { name: "Base version" }).textContent).toBe("v1");
});

it.each([false, true])("submits a pending ask with its original version and anchor when its quote is missing=%s", async (missing) => {
  window.localStorage.setItem("bb-plugin-plans:draft:plan-1", JSON.stringify({ pendingComment: {
    quote: "Step 1.", body: "Keep this question", kind: "ask", versionId: "v1", prefix: "Plan ", suffix: "", position: 5,
  } }));
  const backend = fakeBackend([makePlan()]);
  slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: backend.rpc });
  const field = await slot.findByLabelText("Ask");
  backend.plans.get("plan-1")!.versions.push({ ...version(2, missing ? "# Plan\n\nReplacement." : "# Plan\n\nNew introduction.\n\nStep 1."), source: "agent" });
  await slot.behavior.emitRealtime("plans-changed", { id: "plan-1" });
  expect(slot.getByLabelText("Ask")).toBe(field);
  expect((field as HTMLTextAreaElement).value).toBe("Keep this question");
  expect(Boolean(slot.queryByText("The quoted text changed."))).toBe(missing);
  if (missing) {
    expect(field.closest('[role="dialog"]')?.classList.contains("top-2")).toBe(true);
  }
  fireEvent.click(slot.getByRole("button", { name: "Add ask" }));
  await waitFor(() => expect(backend.plans.get("plan-1")!.comments).toHaveLength(1));
  expect(backend.plans.get("plan-1")!.comments[0]).toMatchObject({ versionId: "v1", quote: "Step 1.", body: "Keep this question", kind: "ask" });
  const input = slot.inspection.rpcCalls.find((call) => call.method === "addAnnotation")!.input as { position?: number };
  expect(input).toMatchObject({ versionId: "v1", prefix: "Plan ", suffix: "", position: 5 });
});

it("shows a dropped approval without claiming delivery", async () => {
  const backend = fakeBackend([makePlan({ status: "approved" })]);
  slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: {
    ...backend.rpc, deliveryStatus: () => [{ id: "approval", kind: "approved", state: "dropped", attempts: 0, nextAttemptAt: 0 }],
  } });
  await slot.findByText("Approval not delivered. The linked thread is archived or deleted.");
  expect(slot.queryByText("Approval sent to the thread")).toBeNull();
});

it("shows a cancelled approval without claiming delivery", async () => {
  const backend = fakeBackend([makePlan({ status: "approved" })]);
  slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: {
    ...backend.rpc, deliveryStatus: () => [{ id: "approval", kind: "approved", state: "cancelled", attempts: 0, nextAttemptAt: 0 }],
  } });
  await slot.findByText(/Approval not delivered · cancelled/);
  expect(slot.queryByText("Approval sent to the thread")).toBeNull();
});

it("explains that plan deletion also removes queued feedback", async () => {
  const backend = fakeBackend([makePlan({ comments: [comment()] })]);
  slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: backend.rpc });
  fireEvent.keyDown(await slot.findByRole("button", { name: "Plan actions" }), { key: "Enter" });
  fireEvent.click(await within(document.body).findByRole("menuitem", { hidden: true, name: /Delete/ }));
  await slot.findByText("This removes all 1 versions and 1 annotations, and any queued feedback message. The thread's history stays.");
});

describe("keyboard shortcut cheat sheet", () => {
  it("lists the review and composer shortcuts from the actions menu", async () => {
    const backend = fakeBackend([makePlan()]);
    slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: backend.rpc });
    fireEvent.keyDown(await slot.findByRole("button", { name: "Plan actions" }), { key: "Enter" });
    fireEvent.click(await within(document.body).findByRole("menuitem", { hidden: true, name: "Keyboard shortcuts" }));
    const dialog = within(await within(document.body).findByRole("dialog", { name: "Keyboard shortcuts" }));
    for (const key of ["C", "A", "D", "G", "?", "Esc"]) expect(dialog.getByText(key, { selector: "kbd" })).toBeTruthy();
    expect(dialog.getByText("Redline the selection (saves directly)")).toBeTruthy();
    expect(dialog.getByText("Submit the text")).toBeTruthy();
    expect(dialog.getAllByText(/Enter$/, { selector: "kbd" }).length).toBeGreaterThan(0);
  });

  it("hides the direct-save rows on an approved plan", async () => {
    const backend = fakeBackend([makePlan({ status: "approved" })]);
    slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: backend.rpc });
    fireEvent.keyDown(await slot.findByRole("button", { name: "Plan actions" }), { key: "Enter" });
    fireEvent.click(await within(document.body).findByRole("menuitem", { hidden: true, name: "Keyboard shortcuts" }));
    const dialog = within(await within(document.body).findByRole("dialog", { name: "Keyboard shortcuts" }));
    expect(dialog.getByText("C", { selector: "kbd" })).toBeTruthy();
    expect(dialog.queryByText("D", { selector: "kbd" })).toBeNull();
    expect(dialog.queryByText("G", { selector: "kbd" })).toBeNull();
  });

  it("opens with the ? key unless the reviewer is typing", async () => {
    const backend = fakeBackend([makePlan()]);
    slot = render(threadAction, { threadId: "thr_1", params: null }, { rpc: backend.rpc });
    await slot.findByRole("button", { name: "Plan actions" });
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "?", shiftKey: true });
    expect(within(document.body).queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    input.remove();
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    expect(await within(document.body).findByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });
});
