// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginMessageDirectiveProps, PluginThreadHeaderActionProps, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import {
  type Answer,
  type AnswerState,
  type Question,
  type Round,
  type Submission,
  type ThreadState,
  actionableFailures,
  emptyAnswer,
} from "../lib/model";

const toasts = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("sonner", () => {
  const record = (kind: string) => (message: unknown) => {
    toasts.calls.push(`${kind}:${String(message)}`);
  };
  const toast = Object.assign(record("plain"), {
    success: record("success"),
    error: record("error"),
    warning: record("warning"),
  });
  return { toast };
});

const app = await loadPluginApp(() => import("../app"));
const THREAD = "thr_1";

function question(id: string, overrides: Partial<Question> = {}): Question {
  return {
    id,
    title: `${id} title?`,
    help: null,
    group: null,
    select: null,
    options: [],
    cites: [],
    attachments: false,
    references: false,
    confidence: false,
    ...overrides,
  };
}

function round(id: string, number: number, questions: Question[], mode: Round["mode"] = "notebook", intro: string | null = null): Round {
  return { id, threadId: THREAD, number, mode, intro, questions, createdAt: number };
}

function answer(questionId: string, roundId: string, draft: Answer | null, version: number, submitted: Answer | null = null): AnswerState {
  return { questionId, roundId, draft, version, submitted, submittedAt: submitted ? 5 : null, submissionId: submitted ? "s0" : null };
}

function submission(id: string, state: Submission["state"], questionIds: string[], createdAt: number): Submission {
  return { id, threadId: THREAD, state, questionIds, snapshot: {}, error: state === "failed" ? "refused" : null, retryOf: null, createdAt, settledAt: createdAt };
}

/** In-memory backend that mirrors the real RPC contract semantics. */
function backend(initial: Partial<ThreadState> = {}) {
  const state: ThreadState = {
    threadId: THREAD,
    rounds: [],
    answers: [],
    summary: null,
    submissions: [],
    ...initial,
  };
  const calls: { method: string; input: unknown }[] = [];
  const handlers = {
    questions_state: async () => {
      calls.push({ method: "questions_state", input: null });
      return structuredClone(state);
    },
    questions_round: async ({ roundId }: { threadId: string; roundId: string }) => {
      const found = state.rounds.find((item) => item.id === roundId) ?? null;
      const labels: Record<string, string> = {};
      let index = 0;
      for (const item of state.rounds) for (const q of item.questions) labels[q.id] = `Q${++index}`;
      const ids = new Set(found?.questions.map((q) => q.id) ?? []);
      return { round: found, answers: state.answers.filter((item) => ids.has(item.questionId)), labels };
    },
    questions_save_draft: async (input: { threadId: string; questionId: string; draft: Answer; expectedVersion: number }) => {
      calls.push({ method: "questions_save_draft", input });
      const current = state.answers.find((item) => item.questionId === input.questionId);
      const version = current?.version ?? 0;
      if (version !== input.expectedVersion) return { outcome: "conflict" as const, state: current! };
      const roundId = state.rounds.find((item) => item.questions.some((q) => q.id === input.questionId))?.id ?? "";
      const next = { ...(current ?? answer(input.questionId, roundId, null, 0)), draft: input.draft, version: version + 1 };
      state.answers = [...state.answers.filter((item) => item.questionId !== input.questionId), next];
      return { outcome: "saved" as const, state: next };
    },
    questions_upload_attachment: async () => {
      throw new Error("not used");
    },
    questions_attachment_preview: async () => ({ dataUrl: null }),
    questions_search_paths: async ({ query }: { threadId: string; query: string }) => {
      calls.push({ method: "questions_search_paths", input: query });
      return {
        environmentId: "env_1",
        hostId: "host_1",
        hits: [
          { path: "plugins/activity/app.tsx", name: "app.tsx", kind: "file" as const },
          { path: "README.md", name: "README.md", kind: "file" as const },
        ].filter((hit) => hit.path.toLowerCase().includes(query.toLowerCase())),
        truncated: false,
        unavailable: null,
      };
    },
    questions_submit: async (input: { threadId: string; submissionId: string; items: { questionId: string; expectedVersion: number }[]; retryOf: string | null }) => {
      calls.push({ method: "questions_submit", input });
      const ids = input.retryOf ? state.submissions.find((item) => item.id === input.retryOf)?.questionIds ?? [] : input.items.map((item) => item.questionId);
      const created = submission(input.submissionId, "sent", ids, Date.now());
      created.retryOf = input.retryOf;
      state.submissions = [created, ...state.submissions];
      for (const id of ids) {
        const current = state.answers.find((item) => item.questionId === id);
        if (current) current.submitted = current.draft;
      }
      return { outcome: "submitted" as const, submission: created };
    },
  };
  return { state, calls, handlers };
}

const slots: ReturnType<typeof renderSlot>[] = [];
function mountPanel(server: ReturnType<typeof backend>, params: Record<string, string> | null = null) {
  const registration = app.threadPanelActions.find((item) => item.id === "notebook")!;
  const slot = renderSlot<PluginThreadPanelProps, typeof rpcContract>(
    registration,
    { threadId: THREAD, params },
    { rpc: server.handlers, context: { projectId: "proj", threadId: THREAD } },
  );
  slots.push(slot);
  return slot;
}

beforeEach(() => {
  toasts.calls.length = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  for (const slot of slots.splice(0)) slot.lifecycle.unmount();
  cleanup();
});

describe("registrations", () => {
  it("registers the panel action, header control, and directive", () => {
    expect(app.threadPanelActions.map((item) => item.id)).toEqual(["notebook"]);
    expect(app.threadPanelActions[0]?.layout).toBe("flush");
    expect(app.threadHeaderActions.map((item) => item.id)).toEqual(["questions"]);
    expect(app.messageDirectives.map((item) => item.id)).toEqual(["questions"]);
  });
});

describe("Notebook panel", () => {
  it("shows round tabs, thread-wide question numbers, groups, and the Summary tab", async () => {
    const server = backend({
      rounds: [
        round("r1", 1, [question("q1", { group: "Display", select: "single", options: [{ id: "o1", label: "Panel" }, { id: "o2", label: "Thread" }] }), question("q2", { group: "Display" })]),
        round("r2", 2, [question("q3", { cites: ["q1"] })], "notebook", "Follow-ups."),
      ],
      answers: [answer("q1", "r1", { ...emptyAnswer(), selected: ["o1"] }, 2, { ...emptyAnswer(), selected: ["o1"] })],
    });
    const slot = mountPanel(server);
    await slot.findByText("Follow-ups.");
    expect((slot.getByRole("tab", { name: /Round 1/ })).textContent).toMatch("1/2");
    expect((slot.getByRole("tab", { name: /Round 2/ })).getAttribute("aria-selected")).toBe("true");
    expect(slot.getByText("Q3")).toBeTruthy();
    expect((slot.getByRole("tab", { name: /Summary/ })).textContent).toMatch("2 open");
    // The citation quotes the submitted answer to Q1 and expands in place.
    const cite = slot.getByRole("button", { name: /Round 1 · Q1/ });
    expect((cite).textContent).toMatch("Panel");
    fireEvent.click(cite);
    expect(slot.getByText("Your answer")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Go to Q1" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Collapse reference to Q1" }));
    expect(slot.queryByText("Your answer")).toBeNull();

    fireEvent.click(slot.getByRole("tab", { name: /Round 1/ }));
    expect(slot.getByText("Display")).toBeTruthy();
    expect(slot.getByText("Q1")).toBeTruthy();
    fireEvent.click(slot.getByRole("tab", { name: /Summary/ }));
    expect(slot.getByText(/Submitted · 1/)).toBeTruthy();
    expect(slot.getByText(/Open · 2/)).toBeTruthy();
  });

  it("saves an option choice with the base version and enables Submit answered", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = backend({
      rounds: [round("r1", 1, [question("q1", { select: "single", options: [{ id: "o1", label: "Panel" }, { id: "o2", label: "Thread" }] })])],
    });
    const slot = mountPanel(server);
    await slot.findByText("q1 title?");
    const submit = slot.getByRole("button", { name: /Submit every draft/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect((submit).textContent).toMatch("Submit answered (0)");
    fireEvent.click(slot.getByLabelText("Panel"));
    expect((submit).textContent).toMatch("Submit answered (1)");
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const save = server.calls.find((call) => call.method === "questions_save_draft");
    expect(save?.input).toMatchObject({ questionId: "q1", expectedVersion: 0, draft: { selected: ["o1"] } });

    fireEvent.click(submit);
    await waitFor(() => expect(server.calls.some((call) => call.method === "questions_submit")).toBe(true));
    const sent = server.calls.find((call) => call.method === "questions_submit")?.input as { items: unknown[]; submissionId: string };
    expect(sent.items).toEqual([{ questionId: "q1", expectedVersion: 1 }]);
    expect(sent.submissionId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(toasts.calls).toContain("success:Sent 1 answer."));
    await waitFor(() => expect((slot.getByRole("button", { name: /Submit every draft/ })).textContent).toMatch("Submit answered (0)"));
    vi.useRealTimers();
  });

  it("reveals the text field from Type an answer and keeps a paperclip only where asked", async () => {
    const server = backend({
      rounds: [
        round("r1", 1, [
          question("q1", { select: "multiple", options: [{ id: "o1", label: "A" }] }),
          question("q2", { attachments: true }),
          question("q3", { confidence: true, select: "single", options: [{ id: "o1", label: "Yes" }] }),
        ]),
      ],
    });
    const slot = mountPanel(server);
    await slot.findByText("q1 title?");
    expect(slot.queryByLabelText("Answer in your own words")).toBeNull();
    fireEvent.click(slot.getAllByRole("button", { name: "Type an answer" })[0]!);
    expect(slot.getByLabelText("Answer in your own words")).toBeTruthy();
    expect(slot.getAllByRole("button", { name: "Attach file or image" })).toHaveLength(1);
    expect(slot.getByRole("group", { name: "Confidence" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "high" }));
    expect((slot.getByRole("button", { name: "high" })).getAttribute("aria-pressed")).toBe("true");
  });

  it("does not let draft edits change the quoted submitted answer", async () => {
    const submitted = { ...emptyAnswer(), text: "sent text" };
    const server = backend({
      rounds: [round("r1", 1, [question("q1")]), round("r2", 2, [question("q2", { cites: ["q1"] })])],
      answers: [answer("q1", "r1", submitted, 3, submitted)],
    });
    const slot = mountPanel(server, { roundId: "r1" });
    await slot.findByText("q1 title?");
    fireEvent.change(slot.getByLabelText("Your answer"), { target: { value: "edited draft" } });
    fireEvent.click(slot.getByRole("tab", { name: /Round 2/ }));
    const cite = await slot.findByRole("button", { name: /Round 1 · Q1/ });
    expect((cite).textContent).toMatch("sent text");
    fireEvent.click(cite);
    expect(slot.getByText("Unsent edits are not shown here.")).toBeTruthy();
  });

  it("searches workspace files, toggles selection with keyboard and mouse, and keeps a pasted link", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1", { references: true })])] });
    const slot = mountPanel(server);
    await slot.findByText("q1 title?");
    const input = slot.getByRole("combobox", { name: "Search files or paste a link" });
    fireEvent.change(input, { target: { value: "app" } });
    const option = await slot.findByRole("option", { name: /app\.tsx/ });
    expect((option).textContent).toMatch("plugins/activity/app.tsx");
    fireEvent.keyDown(input, { key: "Enter" });
    expect((slot.getByRole("option", { name: /app\.tsx/ })).getAttribute("aria-selected")).toBe("true");
    expect(within(slot.container).getAllByRole("button", { name: "app.tsx" })).toHaveLength(1);
    expect(slot.queryByRole("button", { name: /^Add$/ })).toBeNull();

    fireEvent.change(input, { target: { value: "https://github.com/get-bb/bb/pull/1" } });
    const link = await slot.findByRole("option", { name: /github\.com/ });
    fireEvent.click(link);
    expect(slot.getByRole("button", { name: "Remove https://github.com/get-bb/bb/pull/1" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Remove plugins/activity/app.tsx" }));
    expect(slot.queryByRole("button", { name: "Remove plugins/activity/app.tsx" })).toBeNull();
  });

  it("shows a retry notice for every attempt that still owns a question", async () => {
    const server = backend({
      rounds: [round("r1", 1, [question("q1"), question("q2")])],
      submissions: [submission("s2", "sent", ["q2"], 20), submission("s1", "uncertain", ["q1"], 10), submission("s0", "failed", ["q2"], 5)],
    });
    expect(actionableFailures(server.state.submissions).map((item) => item.id)).toEqual(["s1"]);
    const slot = mountPanel(server);
    const alert = await slot.findByRole("alert");
    expect((alert).textContent).toMatch("Delivery of Q1 is uncertain.");
    expect((alert).textContent).toMatch("submission s1");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry this submission" }));
    await waitFor(() => expect(server.calls.some((call) => call.method === "questions_submit")).toBe(true));
    expect(server.calls.find((call) => call.method === "questions_submit")?.input).toMatchObject({ retryOf: "s1", items: [] });
  });

  it("switches to a round that arrives over realtime and keeps the tab on reload", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1")])] });
    const slot = mountPanel(server);
    await slot.findByText("q1 title?");
    server.state.rounds.push(round("r2", 2, [question("q2")]));
    await slot.behavior.emitRealtime("questions-changed", { threadId: THREAD, kind: "round-created", roundId: "r2" });
    await slot.findByText("q2 title?");
    expect((slot.getByRole("tab", { name: /Round 2/ })).getAttribute("aria-selected")).toBe("true");
  });
});

describe("Message directive", () => {
  function mountDirective(server: ReturnType<typeof backend>, roundId: string) {
    const registration = app.messageDirectives[0]!;
    const slot = renderSlot<PluginMessageDirectiveProps, typeof rpcContract>(
      registration,
      {
        attributes: { round: roundId },
        source: `::questions{round="${roundId}"}`,
        message: { id: "m1", threadId: THREAD, turnId: null, projectId: "proj" },
        openWorkspaceFile: null,
      },
      { rpc: server.handlers, context: { projectId: "proj", threadId: THREAD }, openThreadPanel: () => true },
    );
    slots.push(slot);
    return slot;
  }

  it("renders an inline round with choices and Type an answer, and submits only that round", async () => {
    const server = backend({
      rounds: [
        round("r1", 1, [question("q1")]),
        round("r2", 2, [question("q2", { select: "single", options: [{ id: "o1", label: "Yes" }, { id: "o2", label: "No" }] }), question("q3")], "inline", "Two quick ones."),
      ],
      answers: [answer("q1", "r1", { ...emptyAnswer(), text: "pending elsewhere" }, 1)],
    });
    const slot = mountDirective(server, "r2");
    await slot.findByText("Two quick ones.");
    expect(slot.getByText("Q2")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Type an answer" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Attach file or image" })).toBeNull();
    fireEvent.click(slot.getByLabelText("Yes"));
    expect(slot.queryByRole("button", { name: "+ detail" })).toBeNull();
    const submit = slot.getByRole("button", { name: /Submit answered/ });
    expect((submit).textContent).toMatch("Submit answered (1)");
    fireEvent.click(submit);
    await waitFor(() => expect(server.calls.some((call) => call.method === "questions_submit")).toBe(true));
    const sent = server.calls.find((call) => call.method === "questions_submit")?.input as { items: { questionId: string }[] };
    expect(sent.items.map((item) => item.questionId)).toEqual(["q2"]);
  });

  it("renders a compact card for a notebook round that opens the panel", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1"), question("q2")])] });
    const slot = mountDirective(server, "r1");
    const button = await slot.findByRole("button", { name: "Open notebook" });
    expect(slot.getByText(/2 questions \(Q1–Q2\) · 0 of 2 submitted/)).toBeTruthy();
    fireEvent.click(button);
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "openThreadPanel" });
  });

  it("opens the panel without params and selects the older round it was asked for", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1")]), round("r2", 2, [question("q2")])] });
    const card = mountDirective(server, "r1");
    fireEvent.click(await card.findByRole("button", { name: "Open notebook" }));
    expect(card.inspection.navigateCalls.at(-1)).toEqual({ method: "openThreadPanel", options: { actionId: "notebook", title: "Questions" } });
    // The tab mounts after the click, as it does for a first open.
    const panel = mountPanel(server);
    await panel.findByText("q1 title?");
    expect(panel.getByRole("tab", { name: /Round 1/ }).getAttribute("aria-selected")).toBe("true");
    expect(panel.getByRole("tab", { name: /Round 2/ }).getAttribute("aria-selected")).toBe("false");
  });

  it("switches an open panel to the card's round, and waits for a round its state has not loaded yet", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1")]), round("r2", 2, [question("q2")])] });
    const panel = mountPanel(server);
    await panel.findByText("q2 title?");
    expect(panel.getByRole("tab", { name: /Round 2/ }).getAttribute("aria-selected")).toBe("true");
    // Already-open panel: the card for round 1 switches the tab in place.
    // Slot queries span the document, so scope each card to its own container.
    const older = mountDirective(server, "r1");
    fireEvent.click(await within(older.container).findByRole("button", { name: "Open notebook" }));
    await waitFor(() => expect(panel.getByRole("tab", { name: /Round 1/ }).getAttribute("aria-selected")).toBe("true"));

    // The panel's state lags: rounds 3 and 4 exist for the directive but not
    // for the panel until the next refresh. The request for round 3 must
    // survive that refresh and beat the "newest round" default (round 4).
    const lagging = [...server.state.rounds];
    const full = [...lagging, round("r3", 3, [question("q3")]), round("r4", 4, [question("q4")])];
    let released = false;
    const listState = server.handlers.questions_state;
    server.handlers.questions_state = async () => ({ ...(await listState()), rounds: released ? full : lagging });
    server.state.rounds = full;
    const newer = mountDirective(server, "r3");
    fireEvent.click(await within(newer.container).findByRole("button", { name: "Open notebook" }));
    await panel.behavior.emitRealtime("questions-changed", { threadId: THREAD, kind: "answers" });
    await waitFor(() => expect(server.calls.filter((call) => call.method === "questions_state").length).toBeGreaterThanOrEqual(2));
    const tabs = within(panel.container);
    expect(tabs.queryByRole("tab", { name: /Round 3/ })).toBeNull();
    expect(tabs.getByRole("tab", { name: /Round 1/ }).getAttribute("aria-selected")).toBe("true");
    released = true;
    await panel.behavior.emitRealtime("questions-changed", { threadId: THREAD, kind: "round-created", roundId: "r4" });
    await tabs.findByText("q3 title?");
    expect(tabs.getByRole("tab", { name: /Round 3/ }).getAttribute("aria-selected")).toBe("true");
    expect(tabs.getByRole("tab", { name: /Round 4/ }).getAttribute("aria-selected")).toBe("false");
  });

  it("drops the round request when the host declines to open the panel", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1")]), round("r2", 2, [question("q2")])] });
    const registration = app.messageDirectives[0]!;
    const card = renderSlot<PluginMessageDirectiveProps, typeof rpcContract>(
      registration,
      { attributes: { round: "r1" }, source: "::questions{round=\"r1\"}", message: { id: "m1", threadId: THREAD, turnId: null, projectId: "proj" }, openWorkspaceFile: null },
      { rpc: server.handlers, context: { projectId: "proj", threadId: THREAD }, openThreadPanel: () => false },
    );
    slots.push(card);
    fireEvent.click(await card.findByRole("button", { name: "Open notebook" }));
    expect(toasts.calls.at(-1)).toMatch(/no side panel/);
    const panel = mountPanel(server);
    await panel.findByText("q2 title?");
    expect(panel.getByRole("tab", { name: /Round 2/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("lets the user resolve a save conflict inline and shows load errors", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = backend({
      rounds: [round("r1", 1, [question("q1", { select: "single", options: [{ id: "o1", label: "Yes" }, { id: "o2", label: "No" }] })], "inline")],
    });
    const slot = mountDirective(server, "r1");
    await slot.findByLabelText("Yes");
    // Another client saved first: the server's version is already 1.
    server.state.answers = [answer("q1", "r1", { ...emptyAnswer(), selected: ["o2"] }, 1)];
    fireEvent.click(slot.getByLabelText("Yes"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toMatch(/changed in another window/);
    expect(alert.textContent).toMatch(/Saved version: No/);
    fireEvent.click(within(alert).getByRole("button", { name: "Keep mine" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const saves = server.calls.filter((call) => call.method === "questions_save_draft").map((call) => call.input as { expectedVersion: number });
    expect(saves.map((save) => save.expectedVersion)).toEqual([0, 1]);
    expect(server.state.answers[0]?.draft?.selected).toEqual(["o1"]);
    expect(slot.queryByRole("alert")).toBeNull();
    vi.useRealTimers();

    const broken = backend({ rounds: [round("r2", 1, [question("q9")], "inline")] });
    broken.handlers.questions_state = async () => {
      throw new Error("server down");
    };
    const failed = mountDirective(broken, "r2");
    const error = await failed.findByRole("alert");
    expect(error.textContent).toMatch(/could not be loaded: server down/);
  });

  it("says when the round no longer exists", async () => {
    const server = backend();
    const slot = mountDirective(server, "rnd_missing");
    await slot.findByText("This questions round no longer exists.");
  });
});

describe("Header control", () => {
  function mountHeader(server: ReturnType<typeof backend>, openThreadPanel = vi.fn(() => true)) {
    const registration = app.threadHeaderActions[0]!;
    const slot = renderSlot<PluginThreadHeaderActionProps, typeof rpcContract>(
      registration,
      { threadId: THREAD, projectId: "proj", isCompactViewport: false },
      { rpc: server.handlers, context: { projectId: "proj", threadId: THREAD }, openThreadPanel },
    );
    slots.push(slot);
    return { slot, openThreadPanel };
  }

  it("shows the open count, opens the panel on click, and auto-opens once per new round", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1"), question("q2")])] });
    const { slot, openThreadPanel } = mountHeader(server);
    const button = await slot.findByRole("button", { name: "Questions, 2 open" });
    fireEvent.click(button);
    expect(openThreadPanel).toHaveBeenCalledTimes(1);
    server.state.rounds.push(round("r2", 2, [question("q3")]));
    await slot.behavior.emitRealtime("questions-changed", { threadId: THREAD, kind: "round-created", roundId: "r2" });
    await slot.findByRole("button", { name: "Questions, 3 open" });
    await waitFor(() => expect(openThreadPanel).toHaveBeenCalledTimes(2));
    // No params: the host keys tabs by action + params, and a second params
    // value would open a second Questions tab.
    expect(openThreadPanel).toHaveBeenLastCalledWith({ actionId: "notebook", title: "Questions" });
    await slot.behavior.emitRealtime("questions-changed", { threadId: THREAD, kind: "round-created", roundId: "r2" });
    await slot.behavior.emitRealtime("questions-changed", { threadId: "other", kind: "round-created", roundId: "r3" });
    await waitFor(() => expect(server.calls.filter((call) => call.method === "questions_state").length).toBeGreaterThanOrEqual(3));
    expect(openThreadPanel).toHaveBeenCalledTimes(2);
  });

  it("does not open the panel for an inline round", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1")])] });
    const { slot, openThreadPanel } = mountHeader(server);
    await slot.findByRole("button", { name: "Questions, 1 open" });
    server.state.rounds.push(round("r2", 2, [question("q2")], "inline"));
    await slot.behavior.emitRealtime("questions-changed", { threadId: THREAD, kind: "round-created", roundId: "r2" });
    await slot.findByRole("button", { name: "Questions, 2 open" });
    expect(openThreadPanel).not.toHaveBeenCalled();
  });

  it("renders nothing for a thread without questions", async () => {
    const server = backend();
    const { slot } = mountHeader(server);
    await waitFor(() => expect(server.calls.some((call) => call.method === "questions_state")).toBe(true));
    expect(slot.container.querySelector("button")).toBeNull();
  });
});

describe("Browser backups", () => {
  it("drops corrupted entries and keeps valid ones", async () => {
    const { createLocalStorageBackups } = await import("../lib/draft-store");
    window.localStorage.setItem(`bb-questions-draft:v1:${THREAD}:q1`, "{not json");
    window.localStorage.setItem(`bb-questions-draft:v1:${THREAD}:q2`, JSON.stringify({ answer: { selected: "nope" }, baseVersion: 1 }));
    window.localStorage.setItem(`bb-questions-draft:v1:${THREAD}:q3`, JSON.stringify({ answer: { ...emptyAnswer(), text: "ok" }, baseVersion: 2 }));
    const backups = createLocalStorageBackups();
    expect(backups).not.toBeNull();
    const found = backups!.read(THREAD);
    expect([...found.keys()]).toEqual(["q3"]);
    expect(window.localStorage.getItem(`bb-questions-draft:v1:${THREAD}:q2`)).toBeNull();
  });
});
