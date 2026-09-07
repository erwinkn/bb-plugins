// @vitest-environment jsdom
/**
 * Slot-level tests through the SDK's frontend harness: the registrations
 * validate like the host, rpc is a recorded fake, and the flows below drive
 * the real components (list, create, review footer, revision dialog).
 */
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createElement, type ComponentType } from "react";
import {
  loadPluginApp,
  renderSlot,
  type RenderedSlot,
  type RenderSlotOptions,
} from "@get-bb/plugin-sdk/testing/app";
import type { Plan, PlanComment, PlanVersion, plansContract } from "./contract";

const app = await loadPluginApp(() => import("./app"));
const threadAction = app.threadPanelActions[0]!;

let now = 1_700_000_000_000;
function version(number: number, markdown = `# Plan\n\nStep ${number}.`): PlanVersion {
  return { id: `v${number}`, number, markdown, createdAt: now + number };
}
function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "plan-1",
    title: "Add rate limiting",
    threadId: "thr_1",
    projectId: "proj_1",
    projectName: "Demo",
    status: "review",
    sample: false,
    createdAt: now,
    updatedAt: now,
    versions: [version(1)],
    comments: [],
    ...overrides,
  };
}
function comment(overrides: Partial<PlanComment> = {}): PlanComment {
  return {
    id: "c1",
    versionId: "v1",
    quote: "Step 1.",
    body: "Reconsider this.",
    resolved: false,
    createdAt: now,
    sentAt: null,
    ...overrides,
  };
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
      revise: ({ id, markdown }: { id: string; markdown: string; expectedVersionId: string }) => {
        const plan = get(id);
        plan.versions.push(version(plan.versions.length + 1, markdown));
        plan.status = "review";
        return plan;
      },
      addComment: ({ id, versionId, quote, body = "", kind }: { id: string; versionId: string; quote: string; body?: string; kind?: PlanComment["kind"] }) => {
        const plan = get(id);
        plan.comments.push(comment({ id: `c${plan.comments.length + 1}`, versionId, quote, body, kind }));
        return plan;
      },
      updateComment: ({ id, commentId, body }: { id: string; commentId: string; body: string }) => {
        const plan = get(id);
        plan.comments.find((entry) => entry.id === commentId)!.body = body;
        return plan;
      },
      removeComment: ({ id, commentId }: { id: string; commentId: string }) => {
        const plan = get(id);
        plan.comments = plan.comments.filter((entry) => entry.id !== commentId);
        return plan;
      },
      resolveComment: ({ id, commentId, resolved }: { id: string; commentId: string; resolved: boolean }) => {
        const plan = get(id);
        const target = plan.comments.find((entry) => entry.id === commentId)!;
        target.resolved = resolved;
        return plan;
      },
      submitReview: ({ id, action, note }: { id: string; action: "feedback" | "approve"; note: string }) => {
        const plan = get(id);
        if (action === "approve" && plan.comments.some((entry) => !entry.resolved && entry.kind !== "looksGood" && (entry.sentAt === null || entry.versionId === plan.versions.at(-1)!.id))) {
          throw new Error("Resolve all comments first");
        }
        if (action === "feedback" && note === "" && !plan.comments.some((entry) => entry.sentAt === null)) {
          throw new Error("Feedback needs a comment or a note");
        }
        for (const entry of plan.comments) entry.sentAt ??= now;
        plan.status = action === "approve" ? "approved" : "revising";
        return plan;
      },
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
  window.localStorage.clear();
  Element.prototype.scrollTo ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  if (typeof Range.prototype.getBoundingClientRect !== "function") {
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
  }
});
afterEach(() => {
  slot?.lifecycle.unmount();
  slot = null;
});

describe("registrations", () => {
  it("registers only the thread panel and header actions", () => {
    expect(app.navPanels).toHaveLength(0);
    expect(threadAction.id).toBe("review-plan");
    expect(app.threadHeaderActions).toHaveLength(1);
  });
});

describe("review", () => {
  it("gates feedback on a note or draft comment and sends with a request id", async () => {
    const backend = fakeBackend([makePlan()]);
    slot = render(threadAction, { threadId: "thr_1", params: { planId: "plan-1" } }, { rpc: backend.rpc });
    const send = await slot.findByRole("button", { name: "Send feedback" });
    expect(send).toHaveProperty("disabled", true);
    fireEvent.change(slot.getByLabelText("Note for the agent"), { target: { value: "Tighten the scope." } });
    await waitFor(() => expect(send).toHaveProperty("disabled", false));
    fireEvent.click(send);
    await waitFor(() => expect(backend.plans.get("plan-1")?.status).toBe("revising"));
    expect(slot.getByRole("button", { name: "Approve" })).toHaveProperty("disabled", true);
    const submit = slot.inspection.rpcCalls.find((call) => call.method === "submitReview");
    expect(submit?.input).toMatchObject({ id: "plan-1", versionId: "v1", action: "feedback", note: "Tighten the scope." });
    expect(typeof (submit?.input as { requestId: string }).requestId).toBe("string");
    // The draft note is cleared after a successful send.
    await waitFor(() => expect((slot!.getByLabelText("Note for the agent") as HTMLTextAreaElement).value).toBe(""));
  });

  it("allows approval after sent feedback has a newer revision without resolve controls", async () => {
    const backend = fakeBackend([makePlan({ versions: [version(1), version(2)], comments: [comment({ sentAt: now })] })]);
    slot = render(threadAction, { threadId: "thr_1", params: { planId: "plan-1" } }, { rpc: backend.rpc });
    expect(await slot.findByRole("button", { name: "Approve" })).toHaveProperty("disabled", false);
    expect(slot.queryByRole("button", { name: /Resolve/ })).toBeNull();
  });

  it("asks before approving a real plan, then submits", async () => {
    const backend = fakeBackend([makePlan()]);
    slot = render(threadAction, { threadId: "thr_1", params: { planId: "plan-1" } }, { rpc: backend.rpc });
    fireEvent.click(await slot.findByRole("button", { name: "Approve" }));
    const dialog = await slot.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(backend.plans.get("plan-1")?.status).toBe("approved"));
    await slot.findByText(/Approval sent to the thread/);
  });

  it("adds a revision through the dialog and switches to the changes view", async () => {
    const backend = fakeBackend([makePlan({ status: "revising" })]);
    slot = render(threadAction, { threadId: "thr_1", params: { planId: "plan-1" } }, { rpc: backend.rpc });
    fireEvent.click(await slot.findByRole("button", { name: "Import revision" }));
    const field = await slot.findByLabelText("Revised plan Markdown");
    fireEvent.change(field, { target: { value: "# Plan\n\nStep 1, revised." } });
    fireEvent.click(slot.getByRole("button", { name: /Save as v2/ }));
    await waitFor(() => expect(backend.plans.get("plan-1")?.versions).toHaveLength(2));
    expect(slot.inspection.rpcCalls.find((call) => call.method === "revise")?.input).toMatchObject({
      id: "plan-1",
      expectedVersionId: "v1",
    });
    await waitFor(() => expect(slot!.getByRole("combobox", { name: "Plan view: Changes" })).toBeTruthy());
  });

  it("keeps an unsent note when the plan gains a new version and offers to carry it over", async () => {
    const backend = fakeBackend([makePlan()]);
    slot = render(threadAction, { threadId: "thr_1", params: { planId: "plan-1" } }, { rpc: backend.rpc });
    fireEvent.change(await slot.findByLabelText("Note for the agent"), { target: { value: "Keep me" } });
    await waitFor(() => expect(window.localStorage.length).toBe(1));
    backend.plans.get("plan-1")!.versions.push(version(2));
    await slot.behavior.emitRealtime("plans-changed", { id: "plan-1" });
    await slot.findByText(/unsent draft from v1/);
    fireEvent.click(slot.getByRole("button", { name: "Copy to v2" }));
    await waitFor(() => expect((slot!.getByLabelText("Note for the agent") as HTMLTextAreaElement).value).toBe("Keep me"));
  });
});

describe("comments", () => {
  it("keeps matching new quotes while the document tab is hidden", async () => {
    const backend = fakeBackend([makePlan()]);
    slot = render(threadAction, { threadId: "thr_1", params: { planId: "plan-1" } }, { rpc: backend.rpc });
    fireEvent.keyDown(await slot.findByRole("combobox", { name: /Plan view:/ }), { key: "Enter" });

    fireEvent.keyDown(within(document.body).getByRole("option", { name: /Comments/ }), { key: "Enter" });

    backend.plans.get("plan-1")!.comments.push(
      comment({ id: "present" }),
      comment({ id: "missing", quote: "Absent passage", body: "Missing quote" }),
    );
    await slot.behavior.emitRealtime("plans-changed", { id: "plan-1" });
    await waitFor(() => expect(slot!.getAllByText("This passage is not in the displayed version.")).toHaveLength(1));
    expect(slot.getByRole("combobox", { name: "Plan view: Comments" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Show this passage in the plan" })).toBeTruthy();
  }, 15000);

  it("saves a pending comment that predates selection context without sending undefined fields", async () => {
    const backend = fakeBackend([makePlan()]);
    window.localStorage.setItem(
      "bb-plugin-erwin-plans:draft:plan-1:v1",
      JSON.stringify({ note: "", pendingComment: { quote: "Step 1.", body: "Older draft" } }),
    );
    slot = render(threadAction, { threadId: "thr_1", params: { planId: "plan-1" } }, { rpc: backend.rpc });
    fireEvent.click(await slot.findByRole("button", { name: "Add comment" }));
    await waitFor(() => expect(backend.plans.get("plan-1")?.comments).toHaveLength(1));
    const input = slot.inspection.rpcCalls.find((call) => call.method === "addComment")?.input as Record<string, unknown>;
    expect(input).toMatchObject({ quote: "Step 1.", body: "Older draft" });
    expect(Object.keys(input)).not.toContain("prefix");
    expect(Object.values(input)).not.toContain(undefined);
  });

  it("lets a draft comment be edited and deleted, but not a sent one", async () => {
    const backend = fakeBackend([
      makePlan({ comments: [comment({ id: "draft" }), comment({ id: "sent", body: "Already sent.", sentAt: now })] }),
    ]);
    slot = render(threadAction, { threadId: "thr_1", params: { planId: "plan-1" } }, { rpc: backend.rpc });
    fireEvent.keyDown(await slot.findByRole("combobox", { name: /Plan view:/ }), { key: "Enter" });

    fireEvent.keyDown(within(document.body).getByRole("option", { name: /Comments/ }), { key: "Enter" });

    expect(slot.queryByText("This passage is not in the displayed version.")).toBeNull();
    expect(slot.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(slot.getAllByRole("button", { name: "Edit comment" })).toHaveLength(1);
    fireEvent.click(slot.getByRole("button", { name: "Edit comment" }));
    fireEvent.change(slot.getByLabelText("Edit comment"), { target: { value: "Reworded." } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(backend.plans.get("plan-1")?.comments[0]?.body).toBe("Reworded."));
    fireEvent.click(slot.getByRole("button", { name: "Delete comment" }));
    await waitFor(() => expect(backend.plans.get("plan-1")?.comments).toHaveLength(1));
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
    await slot.findByRole("button", { name: "Send feedback" });
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
    await slot.findByRole("button", { name: "Send feedback" });
  });

  it("opens the thread's only plan straight into review", async () => {
    const backend = fakeBackend([makePlan({ threadId: "thr_9" }), makePlan({ id: "plan-2", threadId: "thr_other" })]);
    slot = render(threadAction, { threadId: "thr_9", params: null }, { rpc: backend.rpc });
    await slot.findByRole("button", { name: "Send feedback" });
    expect(slot.queryByText("plan-2")).toBeNull();
  });
});
