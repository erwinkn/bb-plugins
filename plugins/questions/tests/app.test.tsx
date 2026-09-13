// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginMessageDirectiveProps, PluginPendingInteractionProps, PluginThreadHeaderActionProps, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
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
let THREAD = "thr_1";
let threadSequence = 1;

function question(id: string, overrides: Partial<Question> = {}): Question {
  return {
    id,
    title: `${id} title?`,
    help: null,
    select: null,
    options: [],
    cites: [],
    attachments: false,
    references: false,
    confidence: false,
    ...overrides,
  };
}

function round(id: string, number: number, questions: Question[], mode: Round["mode"] = "panel", intro: string | null = null): Round {
  return { id, threadId: THREAD, number, mode, intro, questions, createdAt: number };
}

function answer(questionId: string, roundId: string, draft: Answer | null, version: number, submitted: Answer | null = null): AnswerState {
  return { questionId, roundId, draft, version, submitted, submittedAt: submitted ? 5 : null, submissionId: submitted ? "s0" : null };
}

function submission(id: string, state: Submission["state"], questionIds: string[], createdAt: number): Submission {
  return { id, threadId: THREAD, state, questionIds, snapshot: {}, error: state === "failed" ? "refused" : null, createdAt, settledAt: createdAt, queuedMessageId: null };
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
    questions_upload_attachment: async (input: { threadId: string; questionId: string; name: string; mimeType: string | null; dataBase64: string; expectedVersion: number }) => {
      calls.push({ method: "questions_upload_attachment", input });
      const current = state.answers.find((item) => item.questionId === input.questionId)!;
      const draft = current?.draft ?? emptyAnswer();
      const next = {
        ...(current ?? answer(input.questionId, "r1", null, 0)),
        version: input.expectedVersion + 1,
        draft: { ...draft, attachments: [...draft.attachments, { type: "localImage" as const, path: "paste.png", name: input.name, mimeType: input.mimeType, sizeBytes: 3 }] },
      };
      state.answers = [...state.answers.filter((item) => item.questionId !== input.questionId), next];
      return { outcome: "saved" as const, state: next };
    },
    questions_attachment_preview: async () => ({ dataUrl: null }),
    questions_search_paths: async ({ query }: { threadId: string; query: string }) => {
      calls.push({ method: "questions_search_paths", input: query });
      return {
        environmentId: "env_1",
        hostId: "host_1",
        hits: [
          { path: "plugins/sidebar/app.tsx", name: "app.tsx", kind: "file" as const },
          { path: "README.md", name: "README.md", kind: "file" as const },
        ].filter((hit) => hit.path.toLowerCase().includes(query.toLowerCase())),
        truncated: false,
        unavailable: null,
      };
    },
    questions_submit: async (input: { threadId: string; submissionId: string; items: { questionId: string; expectedVersion: number }[] }) => {
      calls.push({ method: "questions_submit", input });
      const ids = input.items.map((item) => item.questionId);
      const created = submission(input.submissionId, "sent", ids, Date.now());
      state.submissions = [created, ...state.submissions];
      for (const id of ids) {
        const current = state.answers.find((item) => item.questionId === id);
        if (current) current.submitted = current.draft;
        else {
          const roundId = state.rounds.find((r) => r.questions.some((q) => q.id === id))!.id;
          state.answers.push(answer(id, roundId, emptyAnswer(), 0, emptyAnswer()));
        }
      }
      return { outcome: "submitted" as const, submission: created };
    },
  };
  return { state, calls, handlers };
}

const slots: ReturnType<typeof renderSlot>[] = [];
function mountPanel(server: ReturnType<typeof backend>, params: Record<string, string> | null = null) {
  const registration = app.threadPanelActions.find((item) => item.id === "questions")!;
  const slot = renderSlot<PluginThreadPanelProps, typeof rpcContract>(
    registration,
    { threadId: THREAD, params },
    { rpc: server.handlers, context: { projectId: "proj", threadId: THREAD } },
  );
  slots.push(slot);
  return slot;
}

beforeEach(() => {
  THREAD = `thr_${++threadSequence}`;
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
    expect(app.threadPanelActions.map((item) => item.id)).toEqual(["questions"]);
    expect(app.threadPanelActions[0]?.layout).toBe("flush");
    expect(app.threadHeaderActions.map((item) => item.id)).toEqual(["questions"]);
    expect(app.messageDirectives.map((item) => item.id)).toEqual(["questions"]);
  });
});

describe("Questions panel", () => {
  it("offers to resubmit answers whose queued message was removed", async () => {
    const frozen: Answer = { ...emptyAnswer(), text: "Frozen answer" };
    const server = backend({
      rounds: [round("r1", 1, [question("q1")])],
      answers: [answer("q1", "r1", { ...emptyAnswer(), text: "Edited later" }, 2)],
      submissions: [{ ...submission("c1", "cancelled", ["q1"], 10), snapshot: { q1: frozen }, error: "The queued message was removed before the agent received it." }],
    });
    const slot = mountPanel(server);
    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toContain("Answers to Q1 were not delivered.");
    expect(alert.textContent).toContain("removed before the agent received it");
    fireEvent.click(within(alert).getByRole("button", { name: "Resubmit" }));
    await waitFor(() => expect(server.calls.some((call) => call.method === "questions_submit")).toBe(true));
    const saved = server.calls.find((call) => call.method === "questions_save_draft")!.input as { draft: Answer };
    expect(saved.draft.text).toBe("Frozen answer");
    expect(server.calls.find((call) => call.method === "questions_submit")!.input).toMatchObject({ items: [{ questionId: "q1", expectedVersion: 3 }] });
    await waitFor(() => expect(toasts.calls).toContain("success:Sent 1 answer."));
    await waitFor(() => expect(slot.queryByRole("alert")).toBeNull());
  });

  it("requires every required answer, lets optional answers stay blank, and submits only the active round", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("old")]), round("r2", 2, [question("required"), question("optional", { optional: true })])] });
    const slot = mountPanel(server);
    await slot.findByText("Optional");
    const submit = slot.getByRole("button", { name: "Submit round" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(slot.getAllByLabelText("Your answer")[0]!, { target: { value: "   " } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(slot.getAllByLabelText("Your answer")[0]!, { target: { value: "Required answer" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(server.calls.some((c) => c.method === "questions_submit")).toBe(true));
    expect(server.calls.find((c) => c.method === "questions_submit")!.input).toMatchObject({ items: [{ questionId: "required", expectedVersion: 1 }, { questionId: "optional", expectedVersion: 0 }] });
    await waitFor(() => expect(submit.disabled).toBe(true));
    expect(slot.getByRole("tab", { name: /Round 2/ }).textContent).toContain("2/2");
    fireEvent.click(slot.getByRole("tab", { name: /Summary/ }));
    expect(submit.disabled).toBe(true);
  });
  it("sizes restored and edited text, reacts to width changes, and cleans up observers", async () => {
    let width = 200;
    const widthSpy = vi.spyOn(HTMLTextAreaElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    const clientSpy = vi.spyOn(HTMLTextAreaElement.prototype, "clientHeight", "get").mockReturnValue(40);
    const offsetSpy = vi.spyOn(HTMLTextAreaElement.prototype, "offsetHeight", "get").mockReturnValue(42);
    const scrollSpy = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLTextAreaElement) {
      return this.value.length > 30 ? (width < 150 ? 240 : 120) : 40;
    });
    let notifyResize!: () => void;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { notifyResize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    try {
      const long = "Saved content that takes several lines in the text area.";
      const server = backend({ rounds: [round("r1", 1, [question("q1")])], answers: [answer("q1", "r1", { ...emptyAnswer(), text: long }, 1)] });
      const slot = mountPanel(server);
      const input = await slot.findByLabelText("Your answer") as HTMLTextAreaElement;
      expect(input.style.height).toBe("122px");
      expect(input.className).toContain("text-[16px]");
      expect(input.className).toContain("sm:text-[13px]");
      expect(input.className).toContain("[@media(pointer:coarse)]:text-[16px]");
      width = 100;
      act(() => notifyResize());
      expect(input.style.height).toBe("242px");
      fireEvent.change(input, { target: { value: "short" } });
      expect(input.style.height).toBe("42px");
      fireEvent.change(input, { target: { value: long } });
      expect(input.style.height).toBe("242px");
      slot.lifecycle.unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      widthSpy.mockRestore(); clientSpy.mockRestore(); offsetSpy.mockRestore(); scrollSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  it("does not claim to save while the first load is pending", async () => {
    const server = backend();
    let resolve!: (state: ThreadState) => void;
    server.handlers.questions_state = () => new Promise((done) => { resolve = done; });
    const slot = mountPanel(server);
    await slot.findByText("Loading questions…");
    expect(slot.queryByText("Saving draft…")).toBeNull();
    expect(slot.queryByText("Draft saved")).toBeNull();
    await act(async () => resolve(server.state));
    await slot.findByText("Draft saved");
  });

  it("can attach to a selected choice without selecting Other", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1", { attachments: true, select: "single", options: [{ id: "a", label: "A" }] })])] });
    const slot = mountPanel(server);
    fireEvent.click(await slot.findByRole("radio", { name: "A" }));
    fireEvent.click(slot.getByRole("button", { name: "Attach file or image" }));
    fireEvent.change(slot.getByLabelText("Choose files"), { target: { files: [new File(["abc"], "choice.png", { type: "image/png" })] } });
    await slot.findByRole("button", { name: "Remove choice.png" });
    expect((slot.getByRole("radio", { name: /^A/ }) as HTMLInputElement).checked).toBe(true);
    expect((slot.getByRole("radio", { name: "Other" }) as HTMLInputElement).checked).toBe(false);
    expect(server.state.answers[0]!.draft!.selected).toEqual(["a"]);
    expect(server.state.answers[0]!.draft!.attachments).toHaveLength(1);
  });

  it("keeps legacy single-choice notes separate from Other", async () => {
    const server = backend({
      rounds: [round("r1", 1, [question("q1", { select: "single", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] })])],
      answers: [answer("q1", "r1", { ...emptyAnswer(), selected: ["a"], text: "Original notes" }, 1)],
    });
    const slot = mountPanel(server);
    await slot.findByLabelText("Additional notes");
    expect(slot.getAllByRole("radio").filter((input) => (input as HTMLInputElement).checked)).toHaveLength(1);
    fireEvent.click(slot.getByRole("radio", { name: "B" }));
    expect((slot.getByLabelText("Additional notes") as HTMLTextAreaElement).value).toBe("Original notes");
    fireEvent.click(slot.getByRole("radio", { name: "Other" }));
    expect((slot.getByLabelText("Answer in your own words") as HTMLTextAreaElement).value).toBe("Original notes");
    expect(slot.getAllByRole("radio").filter((input) => (input as HTMLInputElement).checked)).toHaveLength(1);
  });

  it("keeps a partly superseded delivery warning without an invalid retry", async () => {
    const old = { ...submission("old", "uncertain", ["q1", "q2"], 1) };
    const server = backend({ rounds: [round("r1", 1, [question("q1"), question("q2")])], submissions: [submission("new", "sent", ["q2"], 2), old] });
    const slot = mountPanel(server);
    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toContain("Delivery of Q1, Q2 is uncertain.");
    expect(within(alert).queryByRole("button", { name: "Retry this submission" })).toBeNull();
    expect(alert.textContent).toContain("submit the complete round");
  });
  it("pastes images only into attachment-enabled answers", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1", { attachments: true }), question("q2")])] });
    const slot = mountPanel(server);
    await slot.findByText("q1 title?");
    const file = new File(["abc"], "paste.png", { type: "image/png" });
    const clipboardData = { items: [{ kind: "file", type: "image/png", getAsFile: () => file }], getData: () => "" };
    const fields = slot.getAllByLabelText("Your answer");
    expect(fireEvent.paste(fields[1]!, { clipboardData })).toBe(true);
    expect(server.calls.filter((call) => call.method === "questions_upload_attachment")).toHaveLength(0);
    expect(fireEvent.paste(fields[0]!, { clipboardData })).toBe(false);
    await waitFor(() => expect(server.calls.filter((call) => call.method === "questions_upload_attachment")).toHaveLength(1));
    expect(server.calls.find((call) => call.method === "questions_upload_attachment")?.input).toMatchObject({ questionId: "q1", name: "paste.png", dataBase64: "YWJj" });
    await slot.findByRole("button", { name: "Remove paste.png" });
    const clip = slot.getByRole("button", { name: "Attach file or image" });
    expect(clip.className).toContain("top-[5px]");
    expect(clip.className).toContain("right-[5px]");
  });

  it.each(["single", "multiple"] as const)("selects and clears Other for %s choices", async (select) => {
    const server = backend({ rounds: [round("r1", 1, [question("q1", { select, options: [{ id: "o1", label: "A" }] })])] });
    const slot = mountPanel(server);
    await slot.findByText("q1 title?");
    const role = select === "single" ? "radio" : "checkbox";
    fireEvent.click(slot.getByRole(role, { name: "A" }));
    fireEvent.click(slot.getByRole(role, { name: "Other" }));
    fireEvent.change(slot.getByLabelText("Answer in your own words"), { target: { value: "Custom answer" } });
    expect(slot.queryByRole("button", { name: "Remove detail" })).toBeNull();
    if (select === "single") expect((slot.getByRole(role, { name: "A" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(slot.getByRole(role, { name: "Other" }));
    expect(slot.queryByLabelText("Answer in your own words")).toBeNull();
    fireEvent.click(slot.getByRole(role, { name: "Other" }));
    expect((slot.getByLabelText("Answer in your own words") as HTMLTextAreaElement).value).toBe("");
    if (select === "single") {
      fireEvent.change(slot.getByLabelText("Answer in your own words"), { target: { value: "Discard me" } });
      fireEvent.click(slot.getByRole(role, { name: "A" }));
      expect(slot.queryByLabelText("Answer in your own words")).toBeNull();
    }
  });

  it("does not search an empty query when opening the file picker", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1", { references: true })])] });
    const slot = mountPanel(server);
    await slot.findByText("q1 title?");
    fireEvent.focus(slot.getByRole("combobox", { name: "Search files" }));
    await slot.findByText("Type to search files");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(server.calls.filter((call) => call.method === "questions_search_paths")).toHaveLength(0);
  });

  it("shows round tabs, thread-wide question numbers, and the Summary tab", async () => {
    const server = backend({
      rounds: [
        round("r1", 1, [question("q1", { select: "single", options: [{ id: "o1", label: "Panel" }, { id: "o2", label: "Thread" }] }), question("q2")]),
        round("r2", 2, [question("q3", { cites: ["q1"] })], "panel", "Follow-ups."),
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
    expect(slot.queryByText("Display")).toBeNull();
    expect(slot.getByText("Q1")).toBeTruthy();
    fireEvent.click(slot.getByRole("tab", { name: /Summary/ }));
    expect(slot.getByText(/Submitted · 1/)).toBeTruthy();
    expect(slot.getByText(/Open · 2/)).toBeTruthy();
  });

  it("saves an option choice with the base version and enables Submit", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = backend({
      rounds: [round("r1", 1, [question("q1", { select: "single", options: [{ id: "o1", label: "Panel" }, { id: "o2", label: "Thread" }] })])],
    });
    const slot = mountPanel(server);
    await slot.findByText("q1 title?");
    const submit = slot.getByRole("button", { name: /Submit round/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect((submit).textContent).toMatch("Submit");
    fireEvent.click(slot.getByLabelText("Panel"));
    expect((submit).textContent).toMatch("Submit");
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
    await waitFor(() => expect((slot.getByRole("button", { name: /Submit round/ })).textContent).toMatch("Submit"));
    vi.useRealTimers();
  });

  it("reveals the text field from Other and keeps a paperclip only where asked", async () => {
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
    fireEvent.click(slot.getByRole("checkbox", { name: "Other" }));
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

  it("searches workspace files, toggles selection with keyboard and mouse, and keeps selected badges above results", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1", { references: true })])] });
    const slot = mountPanel(server);
    await slot.findByText("q1 title?");
    const input = slot.getByRole("combobox", { name: "Search files" });
    fireEvent.change(input, { target: { value: "app" } });
    const option = await slot.findByRole("option", { name: /app\.tsx/ });
    expect((option).textContent).toMatch("plugins/sidebar/app.tsx");
    fireEvent.keyDown(input, { key: "Enter" });
    expect((slot.getByRole("option", { name: /app\.tsx/ })).getAttribute("aria-selected")).toBe("true");
    expect(within(slot.container).getAllByRole("button", { name: "app.tsx" })).toHaveLength(1);
    expect(slot.queryByRole("button", { name: /^Add$/ })).toBeNull();

    const badges = slot.getByLabelText("Selected files");
    expect(badges.compareDocumentPosition(slot.getByRole("listbox")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Remove plugins/sidebar/app.tsx" }));
    expect(slot.queryByRole("button", { name: "Remove plugins/sidebar/app.tsx" })).toBeNull();
  });

  it("clamps the keyboard row when reopening with fewer results", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1", { references: true })])] });
    const original = server.handlers.questions_search_paths;
    let shrink = false;
    server.handlers.questions_search_paths = async (input) => {
      const result = await original(input);
      return { ...result, hits: shrink ? result.hits.slice(0, 1) : result.hits };
    };
    const slot = mountPanel(server);
    await slot.findByText("q1 title?");
    const input = slot.getByRole("combobox", { name: "Search files" });
    fireEvent.change(input, { target: { value: "." } });
    await slot.findByRole("option", { name: /README/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Escape" });
    shrink = true;
    fireEvent.focus(input);
    await waitFor(() => expect(slot.queryByRole("option", { name: /README/ })).toBeNull());
    const option = slot.getByRole("option", { name: /app\.tsx/ });
    expect(input.getAttribute("aria-activedescendant")).toBe(option.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(option.getAttribute("aria-selected")).toBe("true");
  });
  it("shows a delivery notice without the retired Retry button", async () => {
    const server = backend({
      rounds: [round("r1", 1, [question("q1"), question("q2")])],
      submissions: [submission("s2", "sent", ["q2"], 20), submission("s1", "uncertain", ["q1"], 10), submission("s0", "failed", ["q2"], 5)],
    });
    expect(actionableFailures(server.state.submissions).map((item) => item.id)).toEqual(["s1"]);
    const slot = mountPanel(server);
    const alert = await slot.findByRole("alert");
    expect((alert).textContent).toMatch("Delivery of Q1 is uncertain.");
    expect((alert).textContent).toMatch("submission s1");
    expect(within(alert).queryByRole("button", { name: "Retry this submission" })).toBeNull();
    expect(server.calls.some((call) => call.method === "questions_submit")).toBe(false);
  });

  it("reuses the complete-round request id after a transport failure", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1")])], answers: [answer("q1", "r1", { ...emptyAnswer(), text: "Answer" }, 1)] });
    const requests: string[] = [];
    const send = server.handlers.questions_submit;
    server.handlers.questions_submit = async (input) => {
      requests.push(input.submissionId);
      if (requests.length === 1) throw new Error("connection lost");
      return send(input);
    };
    const slot = mountPanel(server);
    await slot.findByText("q1 title?");
    fireEvent.click(slot.getByRole("button", { name: "Submit round" }));
    await waitFor(() => expect(toasts.calls.some((text) => text.includes("submission was not confirmed"))).toBe(true));
    fireEvent.click(slot.getByRole("button", { name: "Submit round" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]).toBe(requests[1]);
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
  it("keeps a loaded card after refresh failure and recovers on retry", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1")])] });
    const original = server.handlers.questions_round;
    let fail = false;
    server.handlers.questions_round = async (input) => { if (fail) throw new Error("offline"); return original(input); };
    const slot = mountDirective(server, "r1");
    await slot.findByRole("button", { name: "Open" });
    fail = true;
    await slot.behavior.emitRealtime("questions-changed", { threadId: THREAD, kind: "answers" });
    await slot.findByText("Could not refresh questions.");
    expect(slot.getByRole("button", { name: "Open" })).toBeTruthy();
    fail = false;
    fireEvent.click(slot.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(slot.queryByText("Could not refresh questions.")).toBeNull());
  });
  it("recovers an initial card failure on realtime", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1")])] });
    const original = server.handlers.questions_round;
    let fail = true;
    server.handlers.questions_round = async (input) => { if (fail) throw new Error("offline"); return original(input); };
    const slot = mountDirective(server, "r1");
    await slot.findByRole("button", { name: "Try again" });
    fail = false;
    await slot.behavior.emitRealtime("questions-changed", { threadId: THREAD, kind: "answers" });
    await slot.findByRole("button", { name: "Open" });
  });
  it("shows a shared save failure only once with both views mounted", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1")], "inline")] });
    server.handlers.questions_save_draft = async () => { throw new Error("offline"); };
    const panel = mountPanel(server);
    const inline = mountDirective(server, "r1");
    await within(inline.container).findByLabelText("Your answer");
    fireEvent.change(await within(panel.container).findByLabelText("Your answer"), { target: { value: "draft" } });
    await waitFor(() => expect(toasts.calls.filter((text) => text.startsWith("warning:"))).toHaveLength(1));
  });
  it("uses only one action row under the host heading for a native panel round", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1")])] });
    const cancel = vi.fn(async () => {});
    const slot = renderSlot<PluginPendingInteractionProps, typeof rpcContract>(app.pendingInteractions[0]!, {
      interaction: { id: "interaction1", threadId: THREAD, title: "Round 1 — 1 question", payload: { roundId: "r1" }, createdAt: 1, expiresAt: 3_600_001 },
      submit: async () => {}, cancel,
    }, { rpc: server.handlers, context: { projectId: "proj", threadId: THREAD } });
    slots.push(slot);
    const open = await slot.findByRole("button", { name: "Open" });
    const close = slot.getByRole("button", { name: "Cancel" });
    expect(open.parentElement).toBe(close.parentElement);
    expect(slot.queryByText(/Round 1/)).toBeNull();
    expect(open.parentElement?.className).not.toContain("border");
    fireEvent.click(open);
    expect(slot.inspection.navigateCalls).toHaveLength(1);
    fireEvent.click(close);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("renders an inline round in the native interaction slot and supports cancellation", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1", { optional: true })], "inline")] });
    const cancel = vi.fn(async () => {});
    const slot = renderSlot<PluginPendingInteractionProps, typeof rpcContract>(app.pendingInteractions[0]!, {
      interaction: { id: "interaction1", threadId: THREAD, title: "Round 1", payload: { roundId: "r1" }, createdAt: 1, expiresAt: 3_600_001 },
      submit: async () => { throw new Error("Only validated RPC submission may resolve the interaction"); }, cancel,
    }, { rpc: server.handlers, context: { projectId: "proj", threadId: THREAD } });
    slots.push(slot);
    await slot.findByText("Optional");
    expect((slot.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("shares unsaved edits with the panel and submits them before debounce", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1")], "inline")] });
    const panel = mountPanel(server);
    const inline = mountDirective(server, "r1");
    const p = within(panel.container);
    const i = within(inline.container);
    const panelInput = await p.findByLabelText("Your answer");
    const inlineInput = await i.findByLabelText("Your answer");
    fireEvent.change(inlineInput, { target: { value: "inline edit" } });
    expect((panelInput as HTMLTextAreaElement).value).toBe("inline edit");
    fireEvent.change(panelInput, { target: { value: "panel edit" } });
    expect((inlineInput as HTMLTextAreaElement).value).toBe("panel edit");
    fireEvent.click(p.getByRole("button", { name: "Submit round" }));
    await waitFor(() => expect(server.calls.filter((call) => call.method === "questions_submit")).toHaveLength(1));
    expect(server.state.answers[0]!.submitted!.text).toBe("panel edit");
    expect(server.calls.filter((call) => call.method === "questions_save_draft")).toHaveLength(1);
    expect(p.queryByRole("alert")).toBeNull();
    expect(i.queryByRole("alert")).toBeNull();
    inline.lifecycle.unmount();
    fireEvent.change(panelInput, { target: { value: "still mounted" } });
    await waitFor(() => expect(server.state.answers[0]!.draft!.text).toBe("still mounted"));
  });

  it("shares the synchronous send lock across panel and inline buttons", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1")], "inline")] });
    const panel = mountPanel(server);
    const inline = mountDirective(server, "r1");
    const p = within(panel.container);
    const i = within(inline.container);
    fireEvent.change(await p.findByLabelText("Your answer"), { target: { value: "one send" } });
    await i.findByLabelText("Your answer");
    const send = server.handlers.questions_submit;
    let release!: () => void;
    server.handlers.questions_submit = async (input) => { await new Promise<void>((done) => { release = done; }); return send(input); };
    fireEvent.click(p.getByRole("button", { name: "Submit round" }));
    await waitFor(() => expect(release).toBeTypeOf("function"));
    expect((i.getByRole("button", { name: /Submit/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(i.getByRole("button", { name: /Submit/ }));
    await act(async () => release());
    await waitFor(() => expect(server.calls.filter((call) => call.method === "questions_submit")).toHaveLength(1));
  });
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
    expect(slot.getByRole("radio", { name: "Other" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Attach file or image" })).toBeNull();
    fireEvent.click(slot.getByLabelText("Yes"));
    expect(slot.queryByRole("button", { name: "+ detail" })).toBeNull();
    const submit = slot.getByRole("button", { name: /Submit/ });
    expect((submit).textContent).toMatch("Submit");
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(slot.getByLabelText("Your answer"), { target: { value: "Required answer" } });
    fireEvent.click(submit);
    await waitFor(() => expect(server.calls.some((call) => call.method === "questions_submit")).toBe(true));
    const sent = server.calls.find((call) => call.method === "questions_submit")?.input as { items: { questionId: string }[] };
    expect(sent.items.map((item) => item.questionId)).toEqual(["q2", "q3"]);
  });

  it("renders a compact card for a panel round that opens the panel", async () => {
    const server = backend({ rounds: [round("r1", 1, Array.from({ length: 6 }, (_, i) => question(`q${i + 1}`)))] });
    const slot = mountDirective(server, "r1");
    const button = await slot.findByRole("button", { name: "Open" });
    expect(slot.getByText("Round 1 — 6 questions (0/6)")).toBeTruthy();
    fireEvent.click(button);
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "openThreadPanel" });
  });

  it("uses singular wording and counts submitted answers rather than drafts", async () => {
    const server = backend({
      rounds: [round("r1", 1, [question("q1")])],
      answers: [answer("q1", "r1", { ...emptyAnswer(), text: "Draft" }, 1)],
    });
    const slot = mountDirective(server, "r1");
    await slot.findByText("Round 1 — 1 question (0/1)");
    server.state.answers[0]!.submitted = { ...emptyAnswer(), text: "Sent" };
    await slot.behavior.emitRealtime("questions-changed", { threadId: THREAD, kind: "answers" });
    await slot.findByText("Round 1 — 1 question (1/1)");
  });

  it("opens the panel without params and selects the older round it was asked for", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1")]), round("r2", 2, [question("q2")])] });
    const card = mountDirective(server, "r1");
    fireEvent.click(await card.findByRole("button", { name: "Open" }));
    expect(card.inspection.navigateCalls.at(-1)).toEqual({ method: "openThreadPanel", options: { actionId: "questions", title: "Questions" } });
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
    fireEvent.click(await within(older.container).findByRole("button", { name: "Open" }));
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
    fireEvent.click(await within(newer.container).findByRole("button", { name: "Open" }));
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
    fireEvent.click(await card.findByRole("button", { name: "Open" }));
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

    // A separate thread has its own initial load; same-thread views now share it.
    THREAD = `thr_${++threadSequence}`;
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

  it("keeps the launcher after a failed refresh", async () => {
    const server = backend({ rounds: [round("r1", 1, [question("q1")])] });
    const original = server.handlers.questions_state;
    let fail = false;
    server.handlers.questions_state = async () => { if (fail) throw new Error("offline"); return original(); };
    const { slot, openThreadPanel } = mountHeader(server);
    await slot.findByRole("button", { name: "Questions, 1 open" });
    fail = true;
    await slot.behavior.emitRealtime("questions-changed", { threadId: THREAD, kind: "answers" });
    fireEvent.click(slot.getByRole("button", { name: "Questions, 1 open" }));
    expect(openThreadPanel).toHaveBeenCalledTimes(1);
  });
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
    expect(openThreadPanel).toHaveBeenLastCalledWith({ actionId: "questions", title: "Questions" });
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
