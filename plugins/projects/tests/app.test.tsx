// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import type { NewThreadComposerProps } from "@get-bb/plugin-sdk/app";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { memoryStore } from "./helpers";
import { buildOverview, type LiveThread } from "../lib/overview";

// The portable SDK composer stub calls onSubmit without catching rejections.
// Observe the original promise explicitly, like the real host does, so failure
// tests verify that the draft-preserving rejection remains part of our contract.
installTestPluginRuntime();
const composerSubmissions: Promise<unknown>[] = [];
const runtime = (globalThis as unknown as { __bbPluginRuntime: { pluginSdkApp: {
  experimental_NewThreadComposer: React.ComponentType<NewThreadComposerProps>;
} } }).__bbPluginRuntime.pluginSdkApp;
const PortableComposer = runtime.experimental_NewThreadComposer;
runtime.experimental_NewThreadComposer = props => createElement(PortableComposer, {
  ...props, onSubmit: request => {
    const submitted = Promise.resolve(props.onSubmit(request));
    composerSubmissions.push(submitted);
    void submitted.catch(() => undefined);
    return submitted;
  },
});

const app = await loadPluginApp(() => import("../app"));
const mounted: ReturnType<typeof renderSlot>[] = [];
afterEach(() => {
  for (const slot of mounted.splice(0)) slot.unmount();
  cleanup();
  composerSubmissions.length = 0;
});
function overview() {
  const { db, store } = memoryStore();
  store.createProject({
    id: "p1",
    name: "Useful search",
    objective: "Find historical work without opening every thread",
    memberProjectIds: ["repo"],
    coordinatorThreadId: "coordinator",
  });
  const o = buildOverview(store, "p1", new Map(), Date.now());
  db.close();
  o.updates = [
    {
      ref: "U1",
      summary: "Search works; privacy needs your opinion",
      body: "The index includes archived work. We are verifying the results display. Private notes stay excluded until you decide.",
      createdAt: Date.now(),
    },
  ];
  o.inFlight = [
    {
      assignment: "A1",
      role: "review",
      outcome: "Verify archived search results",
      tasks: [{ ref: "T1", title: "Search verification" }],
      owner: {
        worker: "W2",
        label: "Independent reviewer",
        threadId: "review",
        profile: "GPT-6 Astra",
      },
      state: "reported",
      threadBusy: false,
      progress: "Archived matches are correct",
      nextCheckpoint: "Coordinator acceptance of the review",
      warnings: [],
      since: Date.now(),
    },
  ];
  o.remaining = [
    {
      ref: "T2",
      title: "Result descriptions",
      summary: "Explain why each historical result matched",
      status: "planned",
      priority: 2,
      owner: null,
      why: "Waiting for your opinion on privacy.",
    },
  ];
  o.opinionNeeded = [
    {
      ref: "K1",
      title: "Private notes",
      question: "Include private notes in search?",
      context: "Teammates could discover content that used to be private.",
      options: [
        { label: "Exclude", consequences: "Private notes stay invisible." },
        {
          label: "Include",
          consequences: "The full index becomes searchable.",
        },
      ],
      recommendation: "Exclude until access controls exist",
      blocks: [{ ref: "T2", title: "Result descriptions" }],
      askedAt: Date.now(),
    },
  ];
  o.revisit = [
    {
      ref: "K2",
      title: "Reuse the index",
      outcome: "Keep the existing index",
      rationale: "Avoid a migration",
      context: null,
      tradeoff: "Limited capacity",
      revisitReason: "Check capacity before larger projects",
      deadline: null,
      decidedAt: Date.now(),
    },
  ];
  return o;
}
function mount(
  rpc: NonNullable<Parameters<typeof renderSlot>[2]>["rpc"],
  subPath = "p1",
) {
  const slot = renderSlot(
    app.navPanels[0],
    { subPath },
    { rpc: { inventory: () => [], ...rpc } },
  );
  mounted.push(slot);
  return slot;
}
describe("project dashboard", () => {
  it.each(["in-flight", "reported"] as const)("A108 labels coordinator checkpoint provenance in existing %s report details", async stage => {
    const o = overview();
    const checkpoint = { recordedBy: "coordinator", recordedAt: Date.now(), sourceThreadId: "worker-thread" };
    o.inFlight = stage === "in-flight" ? [{ ...o.inFlight[0]!, assignment: "A9", tasks: [{ ref: "T9", title: "Checkpointed work" }], checkpoint }] : [];
    o.awaitingAcceptance = stage === "reported" ? [{ assignment: "A9", role: "work", tasks: [{ ref: "T9", title: "Checkpointed work" }], owner: { worker: "W9", label: "Builder", threadId: "worker-thread" }, outcome: "succeeded", summary: "Verified checkpoint", reportedAt: Date.now(), checkpoint }] : [];
    const command = vi.fn();
    const slot = mount({ list: () => [], overview: () => o, command });
    fireEvent.click(await slot.findByRole("tab", { name: "Tasks" }));
    const region = slot.getByRole("region", { name: stage === "in-flight" ? "In flight" : "Reported" });
    const summary = within(region).getByText("Checkpointed work").closest("summary")!;
    fireEvent.click(summary);
    expect(summary.parentElement?.hasAttribute("open")).toBe(true);
    const label = within(region).getByText("Coordinator checkpoint");
    expect(label.getAttribute("title")).toBe(stage === "in-flight" ? "Recorded by the coordinator from W2" : "Recorded by the coordinator from W9");
    expect(command).not.toHaveBeenCalled();
  });

  it("T57 quiet answers explicitly disable notification without a confirmation flow", async () => {
    const command = vi.fn().mockResolvedValue({});
    const slot = mount({ list: () => [], overview: () => overview(), command });
    const checkbox = await slot.findByRole("checkbox", { name: "Notify coordinator" });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(slot.getByRole("radio", { name: /Exclude Private notes/ }));
    fireEvent.click(checkbox);
    expect(slot.getByText("Save your answer quietly, without a message.")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Save quietly" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][0].command).toEqual({ action: "answer", decision: "K1", choice: "Exclude", note: "", notify: false });
  });

  it("T57 Close quietly needs no option and preserves closure history outside user choices", async () => {
    const o = overview();
    const command = vi.fn().mockImplementation(async () => {
      o.opinionNeeded = [];
      o.closedQuestions = [{ ref: "D1", question: "Include private notes in search?", note: "", closedAt: Date.now() }];
      return { status: "closed", madeBy: null };
    });
    const slot = mount({ list: () => [], overview: () => o, command });
    fireEvent.click(await slot.findByRole("button", { name: "Close quietly" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][0].command).toEqual({ action: "question-close", decision: "K1", note: "" });
    fireEvent.click(slot.getByRole("tab", { name: "Decisions" }));
    fireEvent.click(await slot.findByText("Closed questions · 1"));
    expect(slot.getByText("D1 · Closed quietly · No answer recorded")).toBeTruthy();
    expect(within(slot.getByText("D1 · Closed quietly · No answer recorded").closest("article")!).queryByText("Yours")).toBeNull();
  });

  it.each(["failed", "uncertain"] as const)("T57 saved answers retain honest %s delivery feedback after leaving Inbox", async state => {
    const o = overview();
    const notification = { op: "answer-op", state, coordinatorThreadId: "coordinator", detail: "Connection unavailable" };
    const command = vi.fn().mockImplementation(async () => {
      o.opinionNeeded = [];
      o.answered = [{ ref: "D1", title: "Private notes", question: "Include private notes?", context: null, options: [], recommendation: null, choice: "Exclude", note: "", answeredAt: Date.now(), recordedBy: "worker" }];
      o.decisions = [{ ref: "D1", description: "Exclude", madeBy: "user", review: null, reviewMessage: null, notification, recordedBy: { author: "worker", threadId: "w", assignment: 1 }, updatedAt: Date.now() }];
      return { ref: "D1", notification };
    });
    const slot = mount({ list: () => [], overview: () => o, command });
    fireEvent.click(await slot.findByRole("radio", { name: /Exclude Private notes/ }));
    fireEvent.click(slot.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(slot.getByRole("alert").textContent).toContain("answer saved"));
    fireEvent.click(slot.getByRole("tab", { name: "Decisions" }));
    const row = await slot.findByRole("article", { name: "D1" });
    expect(within(row).getByText("Yours")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /^Okay$/ })).toBeNull();
    if (state === "failed") {
      fireEvent.click(within(row).getByRole("button", { name: "Retry coordinator notification" }));
      await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
      expect(command.mock.calls[1][0].command).toEqual({ action: "answer", decision: "D1", choice: "Exclude", note: "" });
    } else expect(within(row).queryByRole("button", { name: "Retry coordinator notification" })).toBeNull();
  });

  it("A94 Settings section shows saved fallback profiles and resets the chosen field", async () => {
    const resetSetting = vi.fn().mockResolvedValue({ ok: true });
    const section = app.settingsSections.find((section) => section.id === "projects-guidance")!;
    const slot = renderSlot(section, {}, {
      settings: { executionProfiles: JSON.stringify({ implementation: { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high", serviceTier: "fast" } }) },
      rpc: { resetSetting },
    });
    mounted.push(slot);
    expect(slot.getByRole("table", { name: "Global fallback profiles" }).textContent).toContain("codex / gpt-6.1-sol / high / fast");
    fireEvent.click(slot.getByRole("button", { name: "Reset worker instructions" }));
    await waitFor(() => expect(resetSetting).toHaveBeenCalledWith({ field: "workerInstructions" }));
    await slot.findByRole("status");
    expect(slot.getByRole("status").textContent).toBe("Reset worker instructions.");
  });

  it("A94 Settings reset failure remains visible and does not claim success", async () => {
    const resetSetting = vi.fn().mockRejectedValue(new Error("Settings unavailable"));
    const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: { resetSetting } });
    mounted.push(slot);
    fireEvent.click(slot.getByRole("button", { name: "Reset execution profiles" }));
    await slot.findByRole("alert");
    expect(slot.getByRole("alert").textContent).toBe("Settings unavailable");
    expect(slot.queryByRole("status")).toBeNull();
  });
  it("A94 forwards the chosen native model, reasoning and tier from the existing picker", async () => {
    const command = vi.fn().mockResolvedValue({});
    const slot = mount({ list: () => [], overview: () => overview(), command });
    await slot.findByRole("button", { name: "Replace coordinator" });
    fireEvent.click(slot.getByRole("button", { name: "Replace coordinator" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Choose a different model" }));
    fireEvent.change(slot.getByLabelText("Provider ID"), { target: { value: "codex" } });
    fireEvent.change(slot.getByLabelText("Model"), { target: { value: "gpt-6.1-sol" } });
    fireEvent.change(slot.getByLabelText("Reasoning level"), { target: { value: "high" } });
    fireEvent.change(slot.getByLabelText("Service tier"), { target: { value: "fast" } });
    fireEvent.click(slot.getByRole("button", { name: "Apply execution selection" }));
    expect((slot.getByLabelText("Service tier") as HTMLSelectElement).value).toBe("fast");
    fireEvent.click(slot.getByRole("button", { name: "Start replacement" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][0].command.profile).toEqual({
      providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high", serviceTier: "fast",
    });
  });

  it("A94 shows the selected native execution in the existing worker profile display", async () => {
    const { db, store } = memoryStore();
    store.createProject({ id: "p1", name: "Search", objective: "Focused work", memberProjectIds: ["repo"], coordinatorThreadId: "coordinator" });
    const worker = store.createWorker({ projectId: "p1", role: "work", label: "Search", area: "Archived search", bbProjectId: "repo" });
    store.updateWorker("p1", worker.num, { threadId: "worker", generation: 1, providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high", state: "active" });
    store.openGeneration("p1", worker.num, 1, "worker");
    const o = buildOverview(store, "p1", new Map([["worker", { status: "active", archived: false, title: "Search", parentThreadId: "coordinator" }]]), Date.now());
    o.workers.current[0]!.profile = "codex / gpt-6.1-sol / high / fast";
    db.close();
    const slot = mount({ list: () => [], overview: () => o });
    await slot.findByRole("tab", { name: /Threads/ });
    fireEvent.click(slot.getByRole("tab", { name: /Threads/ }));
    fireEvent.click(slot.getByRole("button", { name: "Details for W1 Search" }));
    await slot.findByText("Recorded worker profile: codex / gpt-6.1-sol / high / fast");
  });

  it("starts a replacement using the selected model and checkpoint", async () => {
    const o = overview();
    const command = vi.fn().mockResolvedValue({});
    const slot = mount({ list: () => [], overview: () => o, command });
    await waitFor(() =>
      expect(
        slot.getByRole("button", { name: "Replace coordinator" }),
      ).toBeTruthy(),
    );
    fireEvent.click(slot.getByRole("button", { name: "Replace coordinator" }));
    fireEvent.change(slot.getByLabelText("Handoff checkpoint"), {
      target: {
        value: "Keep the accepted index; finish the privacy decision.",
      },
    });
    fireEvent.click(
      slot.getByRole("checkbox", { name: "Choose a different model" }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Start replacement" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][0]).toMatchObject({
      projectId: "p1",
      command: {
        action: "replace-coordinator",
        checkpoint: "Keep the accepted index; finish the privacy decision.",
        profile: {
          providerId: "claude-code",
          model: "claude-opus-5-5",
          reasoningLevel: "high",
        },
      },
    });
  });
  it("uses the compact Control Room tabs for actual questions, tasks and updates", async () => {
    const o = overview();
    const slot = mount({ list: () => [], overview: () => o });
    await slot.findByRole("tab", { name: /Inbox/ });
    expect(slot.getAllByRole("tab")).toHaveLength(7);
    expect(slot.queryByRole("heading", { name: "Useful search" })).toBeNull();
    expect(slot.getByRole("region", { name: "Needs your input" })).toBeTruthy();
    expect(
      slot.getByText(
        "Teammates could discover content that used to be private.",
      ),
    ).toBeTruthy();
    expect(slot.getByText("Private notes stay invisible.")).toBeTruthy();
    expect(slot.getByText("Exclude until access controls exist")).toBeTruthy();
    fireEvent.click(slot.getByRole("tab", { name: /Tasks/ }));
    expect(slot.getByRole("region", { name: "In flight" })).toBeTruthy();
    expect(slot.getByRole("region", { name: "Remaining" })).toBeTruthy();
    fireEvent.click(slot.getByText("Search verification"));
    expect(slot.getByRole("button", { name: "Accept review" })).toBeTruthy();
    fireEvent.click(slot.getByRole("tab", { name: "Log" }));
    fireEvent.click(slot.getByText(o.updates[0]!.summary));
    expect(slot.getByText(o.updates[0]!.body)).toBeTruthy();
  });
  it("preserves an opinion draft on a failed save, then submits the explicit answer", async () => {
    const o = overview();
    const command = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection unavailable"))
      .mockResolvedValue({});
    const slot = mount({ list: () => [], overview: () => o, command });
    await waitFor(() =>
      expect(slot.getByRole("button", { name: "Send answer" })).toBeTruthy(),
    );
    fireEvent.click(
      slot.getByRole("radio", {
        name: "Exclude Private notes stay invisible.",
      }),
    );
    fireEvent.change(slot.getByLabelText("Add detail (optional)"), {
      target: { value: "Keep notes private" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Send answer" }));
    await waitFor(() =>
      expect(slot.getByRole("alert").textContent).toContain(
        "Connection unavailable",
      ),
    );
    expect(
      (slot.getByLabelText("Add detail (optional)") as HTMLTextAreaElement)
        .value,
    ).toBe("Keep notes private");
    fireEvent.click(slot.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command.mock.calls[1][0]).toEqual({
      projectId: "p1",
      command: {
        action: "answer",
        notify: true,
        decision: "K1",
        choice: "Exclude",
        note: "Keep notes private",
      },
    });
  });
  it("keeps membership loading from flashing a project-creation form", async () => {
    let finish!: (v: unknown) => void;
    const membership = new Promise((r) => {
      finish = r;
    });
    const slot = renderSlot(
      app.threadPanelActions[0],
      { threadId: "worker", params: {} },
      { rpc: { membership: () => membership, overview: () => overview() } },
    );
    mounted.push(slot);
    expect(
      slot.queryByRole("heading", { name: "Start an initiative" }),
    ).toBeNull();
    finish({
      projectId: "p1",
      name: "Useful search",
      role: "work",
      former: false,
    });
    await waitFor(() =>
      expect(
        slot.getByRole("button", { name: /Coordinator:.*Open thread/ }),
      ).toBeTruthy(),
    );
  });
  it("creates a coordinator in the selected checkout", async () => {
    const note =
      "Adopted without releasing its runtime. Project tools load at the next natural session restart.";
    const command = vi
      .fn()
      .mockResolvedValue({ project: { id: "created" }, note });
    const slot = mount(
      {
        list: () => [],
        inventory: () => [
          {
            id: "repo",
            name: "Repository",
            environments: [
              {
                id: "linux",
                path: "/code/repo",
                hostId: "Linux",
                isDefaultHome: true,
              },
            ],
          },
        ],
        command,
      },
      "new",
    );
    await waitFor(() =>
      expect(slot.getByRole("checkbox", { name: "Repository" })).toBeTruthy(),
    );
    fireEvent.change(slot.getByLabelText("Initiative name"), {
      target: { value: "Search" },
    });
    fireEvent.change(
      slot.getByLabelText("What should this initiative achieve?"),
      {
        target: { value: "Find historical work" },
      },
    );
    fireEvent.click(slot.getByRole("checkbox", { name: "Repository" }));
    fireEvent.change(slot.getByLabelText("Coordinator checkout"), {
      target: { value: "linux" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Create initiative" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][0].command.coordinator).toEqual({
      kind: "new",
      bbProjectId: "repo",
      environment: { type: "reuse", environmentId: "linux" },
    });
    expect(sessionStorage.getItem("projects:creation:created")).toBe(note);
    const dashboard = mount(
      { list: () => [], overview: () => overview() },
      "created",
    );
    await waitFor(() => expect(dashboard.getByText(note)).toBeTruthy());
  });
  it("renders vision, objectives and ideas and edits them", async () => {
    const o = overview();
    o.project.context = {
      vision: "Every answer traces back to a source thread.",
      objectives: ["Ship archive search", "Keep private notes private"],
      ideas: ["Per-thread index shards"],
    };
    const command = vi.fn().mockResolvedValue({});
    const slot = mount({ list: () => [], overview: () => o, command });
    await slot.findByRole("tab", { name: "Context" });
    fireEvent.click(slot.getByRole("tab", { name: "Context" }));
    await waitFor(() =>
      expect(
        slot.getByText("Every answer traces back to a source thread."),
      ).toBeTruthy(),
    );
    expect(slot.getByText(/Ship archive search/)).toBeTruthy();
    expect(slot.getByText(/Per-thread index shards/)).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Edit" }));
    fireEvent.change(slot.getByLabelText("Vision"), {
      target: { value: "Search the team can trust." },
    });
    fireEvent.change(slot.getByLabelText("Objectives"), {
      target: { value: "Ship archive search\nAudit access controls" },
    });
    fireEvent.change(slot.getByLabelText("Ideas"), {
      target: { value: "Per-thread index shards" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][0]).toEqual({
      projectId: "p1",
      command: {
        action: "edit",
        name: "Useful search",
        objective: "Find historical work without opening every thread",
        context: {
          vision: "Search the team can trust.",
          objectives: ["Ship archive search", "Audit access controls"],
          ideas: ["Per-thread index shards"],
        },
        expected: {
          name: "Useful search",
          objective: "Find historical work without opening every thread",
          context: {
            vision: "Every answer traces back to a source thread.",
            objectives: ["Ship archive search", "Keep private notes private"],
            ideas: ["Per-thread index shards"],
          },
        },
      },
    });
  });
  it("keeps the edit draft when the overview refreshes", async () => {
    const o = overview();
    let current = o;
    const command = vi.fn().mockImplementation(() => {
      current = {
        ...o,
        project: { ...o.project, paused: true, updatedAt: Date.now() + 1 },
      };
      return Promise.resolve({});
    });
    const slot = mount({ list: () => [], overview: () => current, command });
    await slot.findByRole("tab", { name: "Context" });
    fireEvent.click(slot.getByRole("tab", { name: "Context" }));
    await waitFor(() =>
      expect(slot.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    fireEvent.click(slot.getByRole("button", { name: "Edit" }));
    fireEvent.change(slot.getByLabelText("Vision"), {
      target: { value: "Draft in progress" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Initiative menu" }));
    fireEvent.click(slot.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(slot.getByRole("button", { name: "Resume" })).toBeTruthy(),
    );
    expect((slot.getByLabelText("Vision") as HTMLTextAreaElement).value).toBe(
      "Draft in progress",
    );
  });
  it("conflict keeps the draft, shows current values, and retries on a fresh baseline", async () => {
    const o = overview();
    let current = o;
    const command = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Initiative details changed while you were editing. Your draft is preserved; review the current details before saving.",
        ),
      )
      .mockResolvedValue({});
    const slot = mount({ list: () => [], overview: () => current, command });
    await slot.findByRole("tab", { name: "Context" });
    fireEvent.click(slot.getByRole("tab", { name: "Context" }));
    await waitFor(() =>
      expect(slot.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    fireEvent.click(slot.getByRole("button", { name: "Edit" }));
    fireEvent.change(slot.getByLabelText("Vision"), {
      target: { value: "My draft vision" },
    });
    current = {
      ...o,
      project: {
        ...o.project,
        objective: "New coordinator purpose",
        updatedAt: o.project.updatedAt + 1,
      },
    };
    fireEvent.click(slot.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(
        slot.getByText(/Initiative details changed while you were editing/),
      ).toBeTruthy(),
    );
    expect((slot.getByLabelText("Vision") as HTMLTextAreaElement).value).toBe(
      "My draft vision",
    );
    expect(slot.getByText("New coordinator purpose")).toBeTruthy();
    fireEvent.click(
      slot.getByRole("button", {
        name: "Keep my edits, use current details",
      }),
    );
    expect((slot.getByLabelText("Vision") as HTMLTextAreaElement).value).toBe(
      "My draft vision",
    );
    expect(
      (slot.getByLabelText("Initiative purpose") as HTMLTextAreaElement).value,
    ).toBe("New coordinator purpose");
    fireEvent.click(slot.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    const sent = command.mock.calls[1][0].command;
    expect(sent.objective).toBe("New coordinator purpose");
    expect(sent.context.vision).toBe("My draft vision");
    expect(sent.expected.objective).toBe("New coordinator purpose");
    await waitFor(() =>
      expect(slot.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
  });
  it("treats an option literally named __other__ as a normal choice", async () => {
    const o = overview();
    o.opinionNeeded[0]!.options = [
      { label: "__other__", consequences: "A real recorded option." },
    ];
    const command = vi.fn().mockResolvedValue({});
    const slot = mount({ list: () => [], overview: () => o, command });
    await waitFor(() =>
      expect(
        slot.getByRole("radio", {
          name: "__other__ A real recorded option.",
        }),
      ).toBeTruthy(),
    );
    fireEvent.click(
      slot.getByRole("radio", { name: "__other__ A real recorded option." }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][0]).toEqual({
      projectId: "p1",
      command: {
        action: "answer",
        notify: true,
        decision: "K1",
        choice: "__other__",
        note: "",
      },
    });
  });
  it("requires a written answer when Other is picked", async () => {
    const o = overview();
    const command = vi.fn().mockResolvedValue({});
    const slot = mount({ list: () => [], overview: () => o, command });
    await waitFor(() =>
      expect(
        slot.getByRole("radio", {
          name: "Other Write your own answer.",
        }),
      ).toBeTruthy(),
    );
    const send = () => slot.getByRole("button", { name: "Send answer" });
    fireEvent.click(
      slot.getByRole("radio", { name: "Other Write your own answer." }),
    );
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(slot.getByLabelText("Your answer"), {
      target: { value: "Exclude, but revisit once groups exist." },
    });
    expect((send() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send());
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][0]).toEqual({
      projectId: "p1",
      command: {
        action: "answer",
        notify: true,
        decision: "K1",
        choice: null,
        note: "Exclude, but revisit once groups exist.",
      },
    });
  });
  it("does not allow sending an opinion without a selection", async () => {
    const o = overview();
    const command = vi.fn().mockResolvedValue({});
    const slot = mount({ list: () => [], overview: () => o, command });
    await waitFor(() =>
      expect(
        slot.getByRole("radio", {
          name: "Exclude Private notes stay invisible.",
        }),
      ).toBeTruthy(),
    );
    expect(
      (slot.getByRole("button", { name: "Send answer" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(slot.queryByLabelText("Add detail (optional)")).toBeNull();
    expect(command).not.toHaveBeenCalled();
  });
  it("renders answered questions as your decisions, with the question on demand", async () => {
    const o = overview();
    o.answered = [
      {
        ref: "K3",
        title: "Index format",
        question: "Which index format should we keep?",
        context: "Two prototypes were evaluated.",
        options: [
          { label: "Flat", consequences: "Simpler reads, larger files." },
        ],
        recommendation: null,
        choice: "Flat",
        note: "Flat keeps the migration small.",
        answeredAt: Date.now(),
        recordedBy: "coordinator",
      },
    ];
    o.decisions = [{ ref: "K3", description: "Flat · Flat keeps the migration small.", madeBy: "user", review: null, reviewMessage: null, notification: null, recordedBy: { author: "coordinator", threadId: "coordinator", assignment: null }, updatedAt: Date.now() }];
    const slot = mount({ list: () => [], overview: () => o });
    await slot.findByRole("tab", { name: "Decisions" });
    fireEvent.click(slot.getByRole("tab", { name: "Decisions" }));
    const row = slot.getByRole("article", { name: "K3" });
    expect(within(row).getByText("Flat · Flat keeps the migration small.")).toBeTruthy();
    expect(within(row).getByText("Yours")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /okay/i })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Show all of K3" }));
    expect(within(row).getByText("Which index format should we keep? · Answered in chat, recorded by the coordinator")).toBeTruthy();
  });

  it("keeps telemetry off the dashboard and shows unavailable usage on its page", async () => {
    const o = overview();
    const slot = mount({ list: () => [], overview: () => o });
    await slot.findByRole("button", { name: /Coordinator:.*Open thread/ });
    expect(slot.queryByRole("heading", { name: "Observed usage" })).toBeNull();
    fireEvent.click(slot.getByRole("tab", { name: "Usage" }));
    await slot.findByText("Coverage and definitions");
    expect(slot.queryByRole("heading", { name: "Observed usage" })).toBeNull();
    expect(slot.getAllByText("n/a").length).toBeGreaterThan(0);
    expect(slot.queryByText(/0 tokens/)).toBeNull();
    fireEvent.click(slot.getByText("Coverage and definitions"));
    expect(
      slot.getByText(/0 \/ 1 recorded generation\/member threads/),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("tab", { name: /Inbox/ }));
    await slot.findByRole("button", { name: /Coordinator:.*Open thread/ });
  });

  it("renders endpoint totals, provenance, working staleness and paired wall coverage", async () => {
    const o = overview();
    const thread = o.usage.coordinator.generations[0]!;
    thread.totals = {
      input: 700,
      cachedInput: 400,
      output: 300,
      reasoningOutput: 50,
      total: 1000,
    };
    thread.reporting = true;
    thread.staleWhileActive = true;
    thread.profile = {
      first: { providerId: "codex", model: "gpt-test", at: 1700000000000 },
      last: { providerId: "codex", model: "gpt-test", at: 1700000000000 },
      mixed: false,
    };
    thread.turns = {
      observedCompletions: 2,
      completed: 1,
      failed: 1,
      interrupted: 0,
      unknownStatus: 0,
      paired: 1,
      elapsedMs: 90000,
      unpaired: 1,
    };
    o.usage.totals = thread.totals;
    o.usage.reportingThreads = 1;
    const slot = mount({ list: () => [], overview: () => o });
    await slot.findByRole("button", { name: /Coordinator:.*Open thread/ });
    fireEvent.click(slot.getByRole("tab", { name: "Usage" }));
    expect(slot.getAllByText("1K").length).toBeGreaterThan(0);
    const row = slot.getAllByText("Coordinator G1")[0]!.closest("details")!;
    fireEvent.click(row.querySelector("summary")!);
    expect(
      within(row).getByText(/Codex input includes cached input/),
    ).toBeTruthy();
    expect(
      within(row).getByText(/Historical provider\/model allocation is unknown/),
    ).toBeTruthy();
    expect(within(row).getByText(/Working. Usage may be stale/)).toBeTruthy();
    expect(within(row).getByText("1 / 2")).toBeTruthy();
    expect(within(row).getByText("0 hr 1 min")).toBeTruthy();
    expect(slot.queryByText(/thr_/)).toBeNull();
    fireEvent.click(
      within(row).getByRole("button", { name: "Coordinator G1" }),
    );
    expect(
      slot.navigateCalls.some((call) =>
        JSON.stringify(call).includes("coordinator"),
      ),
    ).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: "role" }));
    expect(slot.getByText("Your threads")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "model" }));
    expect(slot.getByText("Historical allocation unknown")).toBeTruthy();
  });
  it("inherits untouched replacement settings and keeps a failed checkpoint draft", async () => {
    const o = overview();
    const command = vi
      .fn()
      .mockRejectedValueOnce(new Error("Replacement refused"))
      .mockResolvedValue({});
    const slot = mount({ list: () => [], overview: () => o, command });
    await slot.findByRole("button", { name: "Replace coordinator" });
    fireEvent.click(slot.getByRole("button", { name: "Replace coordinator" }));
    fireEvent.change(slot.getByLabelText("Handoff checkpoint"), {
      target: { value: "Preserve this checkpoint" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Start replacement" }));
    await slot.findByText("Replacement refused");
    expect(
      (slot.getByLabelText("Handoff checkpoint") as HTMLTextAreaElement).value,
    ).toBe("Preserve this checkpoint");
    fireEvent.click(slot.getByRole("button", { name: "Start replacement" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command.mock.calls[1]![0].command).toEqual({
      action: "replace-coordinator",
      reason: "Switch coordinator model",
      checkpoint: "Preserve this checkpoint",
    });
    expect(command.mock.calls[1]![0].command).not.toHaveProperty("profile");
  });

  it("shows paused and failed handovers honestly and withdraws through the ledger", async () => {
    const o = overview();
    o.project.paused = true;
    o.project.coordinatorHandover = {
      state: "pending",
      reason: "Fresh context",
      profile: "current effective profile",
      environment: null,
      detail: "Initiative is paused",
      requestedAt: Date.now(),
    };
    o.project.formerCoordinators = [
      {
        threadId: "predecessor",
        endedAt: Date.now(),
        reason: "Replacement",
        holdReason: "its thread has queued messages that would start more work",
        live: { status: "idle", archived: false, title: "Former coordinator" },
      },
    ];
    const command = vi.fn().mockRejectedValueOnce(new Error("Withdraw failed"));
    const slot = mount({ list: () => [], overview: () => o, command });
    await slot.findByText(/Queued handover/);
    expect(
      slot.getByText(/New assignments and queued handovers are held/),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Withdraw" }));
    await slot.findByText("Withdraw failed");
    expect(command.mock.calls[0]![0].command).toEqual({
      action: "coordinator-handover",
      cancel: true,
    });
    fireEvent.click(slot.getByText("Coordinator transfer details"));
    expect(
      slot.getByText(/transfer\/archive is not yet confirmed/),
    ).toBeTruthy();
    expect(
      slot.getByText(/Stays live: its thread has queued messages/),
    ).toBeTruthy();
    expect(slot.queryByText(/Archive G/)).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Inspect predecessor" }));
    expect(
      slot.navigateCalls.some((call) =>
        JSON.stringify(call).includes("predecessor"),
      ),
    ).toBe(true);
  });

  it("keeps each native thread primary action separate from its caret, including nested and retained generations", async () => {
    const o = overview();
    const template = o.memberThreads[0]!;
    o.memberThreads = [
      { ...template, parentKnown: true, parentThreadId: null },
      {
        ...template,
        threadId: "worker",
        workerNum: 1,
        label: "Builder",
        ownership: "worker",
        parentThreadId: "coordinator",
        parentKnown: true,
        generation: 2,
      },
      {
        ...template,
        threadId: "nested",
        label: "Nested child",
        ownership: "user",
        parentThreadId: "worker",
        parentKnown: true,
        generation: null,
      },
      {
        ...template,
        threadId: "user",
        label: "My investigation",
        ownership: "user",
        parentThreadId: "coordinator",
        parentKnown: true,
        generation: null,
      },
      {
        ...template,
        threadId: "old-worker",
        workerNum: 1,
        label: "Builder",
        ownership: "worker",
        parentThreadId: null,
        parentKnown: false,
        generation: 1,
        retained: true,
      },
    ];
    const slot = mount({ list: () => [], overview: () => o });
    await slot.findByRole("tab", { name: /Threads/ });
    fireEvent.click(slot.getByRole("tab", { name: /Threads/ }));
    fireEvent.click(
      slot.getByRole("button", { name: "Details for W1 Builder" }),
    );
    expect(slot.navigateCalls).toHaveLength(0);
    expect(
      slot
        .getByRole("button", { name: "Details for W1 Builder" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(slot.getAllByText(/Yours/)).toHaveLength(2);
    expect(slot.queryByText(/parentless|Your threads/)).toBeNull();
    for (const [name, id] of [
      ["Coordinator", "coordinator"],
      ["W1 Builder", "worker"],
      ["Nested child", "nested"],
      ["My investigation", "user"],
    ]) {
      fireEvent.click(slot.getByRole("button", { name: `Open ${name}` }));
      expect(JSON.stringify(slot.navigateCalls.at(-1))).toContain(id);
    }
    const nested = slot
      .getByRole("button", { name: "Open Nested child" })
      .closest(".cr-thread") as HTMLElement;
    expect(nested.style.getPropertyValue("--depth")).toBe("2");
    fireEvent.click(
      slot.getByRole("button", { name: /Earlier threads/ }),
    );
    const prior = slot.getAllByRole("button", { name: "Open W1 Builder" });
    expect(prior).toHaveLength(2);
    fireEvent.click(prior[1]!);
    expect(JSON.stringify(slot.navigateCalls.at(-1))).toContain("old-worker");
    expect(slot.queryByText("old-worker")).toBeNull();
  });

  it("folds native archived direct and nested conversations, excludes deleted navigation, and keeps unknown members current", async () => {
    const { db, store } = memoryStore();
    store.createProject({
      id: "p1",
      name: "Archive regression",
      objective: "Keep native history honest",
      memberProjectIds: ["repo"],
      coordinatorThreadId: "coordinator",
    });
    const live = new Map<string, LiveThread>([
      [
        "coordinator",
        {
          status: "idle",
          archived: false,
          title: "Coordinator",
          parentThreadId: null,
        },
      ],
    ]);
    for (const [id, parent, state] of [
      ["current", "coordinator", "idle"],
      ["child", "current", "idle"],
      ["archived", "coordinator", "archived"],
      ["archived-child", "current", "archived"],
      ["deleted", "coordinator", "deleted"],
      ["deleted-child", "current", "deleted"],
      ["unknown", "coordinator", "unknown"],
    ]) {
      if (parent === "coordinator")
        store.associateProjectThread({
          projectId: "p1",
          opId: id!,
          threadId: id!,
          label: id!,
          bbProjectId: "repo",
        });
      else
        store.associateNestedThread({
          projectId: "p1",
          threadId: id!,
          label: id!,
          bbProjectId: "repo",
        });
      if (state !== "unknown")
        live.set(id!, {
          status: state === "archived" ? "idle" : state!,
          archived: state === "archived" || state === "deleted",
          title: id!,
          parentThreadId: parent!,
        });
    }
    const o = buildOverview(store, "p1", live, Date.now());
    db.close();
    const recorded = o.usage.threads.map((t) => t.threadId);
    const slot = mount({ list: () => [], overview: () => o });
    await slot.findByRole("tab", { name: /Threads/ });
    fireEvent.click(slot.getByRole("tab", { name: /Threads/ }));
    for (const id of ["archived", "archived-child", "deleted", "deleted-child"])
      expect(slot.queryByRole("button", { name: `Open ${id}` })).toBeNull();
    expect(slot.getByRole("tab", { name: /Threads/ }).textContent).toBe("Threads");
    for (const id of ["current", "child", "unknown"])
      expect(slot.getByRole("button", { name: `Open ${id}` })).toBeTruthy();
    expect(
      (
        slot
          .getByRole("button", { name: "Open child" })
          .closest(".cr-thread") as HTMLElement
      ).style.getPropertyValue("--depth"),
    ).toBe("2");
    fireEvent.click(
      slot.getByRole("button", { name: /Earlier threads/ }),
    );
    for (const id of ["archived", "archived-child"]) {
      fireEvent.click(slot.getByRole("button", { name: `Details for ${id}` }));
      expect(slot.getByText(/archived · User-owned conversation/)).toBeTruthy();
      fireEvent.click(slot.getByRole("button", { name: `Open ${id}` }));
      expect(JSON.stringify(slot.navigateCalls.at(-1))).toContain(id);
    }
    for (const id of ["deleted", "deleted-child"])
      expect(slot.queryByRole("button", { name: `Open ${id}` })).toBeNull();
    expect(o.memberThreads.find((t) => t.threadId === "deleted")).toMatchObject(
      { nativeStatus: "deleted", retained: false },
    );
    expect(o.memberThreads.find((t) => t.threadId === "unknown")).toMatchObject(
      { nativeStatus: null, runtime: "unknown" },
    );
    expect(o.usage.threads.map((t) => t.threadId)).toEqual(recorded);
    expect(recorded).toEqual(
      expect.arrayContaining([
        "archived",
        "archived-child",
        "deleted",
        "deleted-child",
        "unknown",
      ]),
    );
  });

  it("A96 New thread opens native compose immediately without a custom form or create call", async () => {
    const command = vi.fn();
    const slot = mount({ list: () => [], overview: () => overview(), command });
    await slot.findByRole("tab", { name: /Threads/ });
    fireEvent.click(slot.getByRole("tab", { name: /Threads/ }));
    fireEvent.click(slot.getByRole("button", { name: /New thread/ }));
    expect(slot.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "projects", options: { subPath: "p1/compose" } });
    expect(command).not.toHaveBeenCalled();
    expect(slot.queryByLabelText("First message")).toBeNull();
    expect(slot.queryByLabelText("Title (optional)")).toBeNull();
  });

  it("A96 native composer preserves native controls and submits its structured input before navigating", async () => {
    const command = vi.fn().mockResolvedValue({ threadId: "owned-child", note: null });
    const slot = mount({ list: () => [], overview: () => overview(), command }, "p1/compose");
    const composer = await slot.findByTestId("bb-new-thread-composer");
    await waitFor(() => expect(composer.getAttribute("data-default-project-id")).toBe("repo"));
    expect(composer.getAttribute("data-draft-key")).toBe("initiative:p1:new-thread");
    expect(command).not.toHaveBeenCalled();
    fireEvent.change(slot.getByTestId("bb-new-thread-composer-input"), { target: { value: "My own question" } });
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][0]).toMatchObject({ projectId: "p1", command: { action: "thread-create", request: { projectId: "repo", permissionMode: "auto", input: [{ type: "text", text: "My own question", mentions: [] }] } } });
    await waitFor(() => expect(JSON.stringify(slot.navigateCalls)).toContain("owned-child"));
  });

  it("A96 a lost create RPC response preserves the draft and prevents a blind second submission", async () => {
    const command = vi.fn().mockRejectedValue(new Error("Lost RPC response"));
    const slot = mount({ list: () => [], overview: () => overview(), command }, "p1/compose");
    await slot.findByTestId("bb-new-thread-composer");
    fireEvent.change(slot.getByTestId("bb-new-thread-composer-input"), { target: { value: "My own question" } });
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    await slot.findByText("Lost RPC response");
    await expect(composerSubmissions.at(-1)).rejects.toThrow("Lost RPC response");
    expect(slot.queryByTestId("bb-new-thread-composer-submit")).toBeNull();
    expect(slot.getByText(/Your draft is preserved/)).toBeTruthy();
    expect(command).toHaveBeenCalledTimes(1);
    expect(slot.navigateCalls).toEqual([]);
  });

  it("T53 shows a late checkout calmly and drops a stale replacement error once the start settles", async () => {
    const o = overview();
    o.project = { ...o.project, coordinatorStart: { state: "pending", threadId: "next", checkoutPending: true } };
    let current = o;
    const command = vi.fn()
      .mockRejectedValueOnce(new Error("The coordinator BB returned cannot be proven to run on the default checkout."))
      .mockImplementation(async () => {
        current = { ...o, project: { ...o.project, coordinatorGeneration: o.project.coordinatorGeneration + 1, coordinatorThreadId: "next", coordinatorStart: { state: "done", threadId: "next", checkoutPending: false } } };
        return {};
      });
    const slot = mount({ list: () => [], overview: () => current, command });
    await slot.findByText("New coordinator started. Confirming its checkout; this settles on its own.");
    fireEvent.click(slot.getByRole("button", { name: "Replace coordinator" }));
    fireEvent.click(slot.getByRole("button", { name: "Start replacement" }));
    await slot.findByText(/cannot be proven/);
    fireEvent.click(slot.getByRole("button", { name: "Initiative menu" }));
    fireEvent.click(slot.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(slot.queryByText(/cannot be proven/)).toBeNull());
    expect(slot.queryByText(/Confirming its checkout/)).toBeNull();
  });

  it("A99 tabs show only their human labels, with Inbox the only count", async () => {
    const o = overview();
    const slot = mount({ list: () => [], overview: () => o });
    await slot.findByRole("tab", { name: /Inbox/ });
    const tabs = slot.getAllByRole("tab");
    expect(tabs.map(t => t.textContent)).toEqual(["Inbox1", "Decisions", "Threads", "Tasks", "Context", "Log", "Usage"]);
    for (const id of ["inbox", "decisions", "threads", "tasks", "context", "log", "usage"])
      expect(tabs.some(t => t.textContent!.includes(id))).toBe(false);
    // Secondary views carry a real glyph for the narrowest strip, never text.
    for (const tab of tabs.slice(4)) expect(tab.querySelector(".cr-tab-icon svg")).toBeTruthy();
    expect(tabs[0]!.querySelector(".cr-count--hot")).toBeTruthy();
  });

  it("A99 Inbox lists your requests first, then unchecked agent decisions; reports and settled choices stay out", async () => {
    const o = overview();
    const at = Date.now();
    const decision = (ref: string, description: string, extra: Partial<typeof o.decisions[number]> = {}): typeof o.decisions[number] => ({ ref, description, madeBy: "agent", review: "pending", reviewMessage: null, notification: null, recordedBy: { author: "coordinator", threadId: "coordinator", assignment: null }, updatedAt: at, ...extra });
    o.decisions = [
      decision("D1", "Reuse the existing index for this release."),
      decision("D2", "Limit the first import to one repository.", { recordedBy: { author: "worker", threadId: "w", assignment: 2 } }),
      decision("D3", "Already checked.", { review: "okay" }),
      decision("D4", "Use the main checkout.", { madeBy: "user", review: null }),
    ];
    o.awaitingAcceptance = [{ assignment: "A8", role: "work", tasks: [{ ref: "T8", title: "Delivered work" }], owner: { worker: "W8", label: "Builder", threadId: "r" }, outcome: "succeeded", summary: "Verified", reportedAt: at }];
    const command = vi.fn();
    const slot = mount({ list: () => [], overview: () => o, command });
    await slot.findByRole("tab", { name: /Inbox/ });
    expect(slot.getByRole("tab", { name: /Inbox/ }).textContent).toBe("Inbox3");
    const inbox = slot.getByRole("tabpanel");
    const sections = Array.from(inbox.querySelectorAll("section")).map(s => s.getAttribute("aria-label"));
    expect(sections).toEqual(["Needs your input", "Agent decisions to check"]);
    const checks = within(slot.getByRole("region", { name: "Agent decisions to check" })).getAllByRole("article");
    expect(checks.map(c => c.getAttribute("aria-label"))).toEqual(["D2", "D1"]);
    expect(within(checks[0]!).getByText("Limit the first import to one repository.")).toBeTruthy();
    expect(within(checks[0]!).getByText("Worker")).toBeTruthy();
    expect(within(checks[1]!).getByText("Coordinator")).toBeTruthy();
    for (const check of checks) {
      expect(within(check).getByRole("button", { name: "Okay" })).toBeTruthy();
      expect(within(check).getByRole("button", { name: "Not okay" })).toBeTruthy();
    }
    expect(within(inbox).queryByText("Already checked.")).toBeNull();
    expect(within(inbox).queryByText("Use the main checkout.")).toBeNull();
    expect(within(inbox).queryByText("Delivered work")).toBeNull();
    fireEvent.click(slot.getByRole("tab", { name: "Tasks" }));
    expect(within(slot.getByRole("region", { name: "Reported" })).getByText("Delivered work")).toBeTruthy();
    expect(command).not.toHaveBeenCalled();
  });

  it("A99 an empty Inbox says you are up to date, with a neutral count for checks only", async () => {
    const o = overview();
    o.opinionNeeded = [];
    const slot = mount({ list: () => [], overview: () => o });
    await slot.findByRole("tab", { name: /Inbox/ });
    expect(slot.getByText("You’re up to date.")).toBeTruthy();
    expect(slot.getByRole("tab", { name: /Inbox/ }).textContent).toBe("Inbox");
    o.decisions = [{ ref: "D5", description: "Keep it.", madeBy: "agent", review: "pending", reviewMessage: null, notification: null, recordedBy: { author: "coordinator", threadId: "c", assignment: null }, updatedAt: Date.now() }];
    const second = mount({ list: () => [], overview: () => o });
    await waitFor(() => expect(second.getAllByRole("tab", { name: /Inbox/ }).at(-1)!.textContent).toBe("Inbox1"));
    expect(second.container.querySelector(".cr-count--hot")).toBeNull();
  });

  it("A99 Decisions keeps the full record and separates agent choices from yours", async () => {
    const o = overview();
    const at = Date.now();
    o.decisions = [
      { ref: "D1", description: "Agent choice.", madeBy: "agent", review: "not-okay", reviewMessage: "Use a smaller index.", notification: { op: "o", state: "sent", coordinatorThreadId: "c" }, recordedBy: { author: "worker", threadId: "w", assignment: 1 }, updatedAt: at },
      { ref: "D2", description: "Your choice.", madeBy: "user", review: null, reviewMessage: null, notification: null, recordedBy: { author: "user", threadId: null, assignment: null }, updatedAt: at },
    ] as typeof o.decisions;
    const slot = mount({ list: () => [], overview: () => o });
    await slot.findByRole("tab", { name: "Decisions" });
    fireEvent.click(slot.getByRole("tab", { name: "Decisions" }));
    const panel = slot.getByRole("tabpanel");
    expect(within(panel).getAllByRole("article").map(a => a.getAttribute("aria-label"))).toEqual(["D2", "D1"]);
    expect(within(slot.getByRole("article", { name: "D1" })).getByText("Not okay")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Yours" }));
    expect(within(panel).getAllByRole("article").map(a => a.getAttribute("aria-label"))).toEqual(["D2"]);
    fireEvent.click(within(panel).getByRole("button", { name: "Agents" }));
    expect(within(panel).getAllByRole("article").map(a => a.getAttribute("aria-label"))).toEqual(["D1"]);
    fireEvent.click(within(panel).getByRole("button", { name: "Show all of D1" }));
    expect(within(panel).getByText("Use a smaller index.")).toBeTruthy();
  });

  it("A96 decision rejection requires and sends a message while Okay is one click", async () => {
    const o = overview(); o.revisit = [];
    o.decisions = [{ ref: "D1", description: "Reuse the index.", madeBy: "agent", review: "pending", reviewMessage: null, notification: null, recordedBy: { author: "worker", threadId: "worker", assignment: 1 }, updatedAt: Date.now() }];
    const command = vi.fn().mockResolvedValue({});
    const slot = mount({ list: () => [], overview: () => o, command });
    await slot.findByRole("tab", { name: /Inbox/ });
    expect(slot.getByText("D1")).toBeTruthy();
    expect(slot.getByText("Reuse the index.")).toBeTruthy();
    expect(slot.queryByText(/quote|citation/i)).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /^Okay$/ }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][0].command).toEqual({ action: "decision-review", decision: "D1", verdict: "okay", message: "" });
    fireEvent.click(slot.getByRole("button", { name: /^Not okay$/ }));
    expect((slot.getByRole("button", { name: "Send and mark not okay" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(slot.getByLabelText("Message to coordinator"), { target: { value: "Use a smaller index." } });
    fireEvent.click(slot.getByRole("button", { name: "Send and mark not okay" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command.mock.calls[1][0].command).toEqual({ action: "decision-review", decision: "D1", verdict: "not-okay", message: "Use a smaller index." });
  });

  it("A96 tab labels are not repeated as headings and legacy records are absent from active UI", async () => {
    const slot = mount({ list: () => [], overview: () => overview(), command: vi.fn() });
    await slot.findByRole("tab", { name: /Tasks/ });
    for (const name of ["Tasks", "Context", "Usage"]) {
      fireEvent.click(slot.getByRole("tab", { name: new RegExp(name) }));
      expect(slot.queryByRole("heading", { name })).toBeNull();
    }
    expect(slot.queryByText(/Knowledge and decisions/)).toBeNull();
  });

  it("accepts and rejects reports with real ledger actions and preserves failures", async () => {
    const o = overview();
    o.awaitingAcceptance = [
      {
        assignment: "A8",
        role: "work",
        tasks: [{ ref: "T8", title: "Delivered work" }],
        owner: { worker: "W8", label: "Builder", threadId: "report-thread" },
        outcome: "succeeded",
        summary: "Verified behavior",
        reportedAt: Date.now(),
      },
    ];
    const command = vi
      .fn()
      .mockRejectedValueOnce(new Error("Acceptance refused"))
      .mockResolvedValue({});
    const slot = mount({ list: () => [], overview: () => o, command });
    await slot.findByRole("tab", { name: "Tasks" });
    fireEvent.click(slot.getByRole("tab", { name: "Tasks" }));
    fireEvent.click(slot.getByText("Delivered work"));
    fireEvent.click(slot.getByRole("button", { name: "Accept T8" }));
    await slot.findByText("Acceptance refused");
    expect(command.mock.calls[0]![0].command).toEqual({
      action: "task-accept",
      task: "T8",
      assignment: "A8",
    });
    fireEvent.click(slot.getByRole("button", { name: "Reject report" }));
    expect(
      (
        slot.getByRole("button", {
          name: "Confirm reject report",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(slot.getByLabelText("Reason for reject report"), {
      target: { value: "Missing a required check" },
    });
    fireEvent.click(
      slot.getByRole("button", { name: "Confirm reject report" }),
    );
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command.mock.calls[1]![0].command).toEqual({
      action: "assignment-reject",
      assignment: "A8",
      reason: "Missing a required check",
    });
  });

  it("preserves answer and context drafts across tabs and replacement inspection", async () => {
    const o = overview();
    const slot = mount({ list: () => [], overview: () => o });
    await slot.findByRole("tab", { name: "Context" });
    fireEvent.click(
      slot.getByRole("radio", { name: "Other Write your own answer." }),
    );
    fireEvent.change(slot.getByLabelText("Your answer"), {
      target: { value: "My pending answer" },
    });
    fireEvent.click(slot.getByRole("tab", { name: "Context" }));
    fireEvent.click(slot.getByRole("button", { name: "Edit" }));
    fireEvent.change(slot.getByLabelText("Vision"), {
      target: { value: "My pending vision" },
    });
    fireEvent.click(slot.getByRole("tab", { name: "Usage" }));
    fireEvent.click(slot.getByRole("button", { name: "Replace coordinator" }));
    fireEvent.click(slot.getByRole("button", { name: "Close replacement" }));
    fireEvent.click(slot.getByRole("tab", { name: "Context" }));
    expect((slot.getByLabelText("Vision") as HTMLTextAreaElement).value).toBe(
      "My pending vision",
    );
    fireEvent.click(slot.getByRole("tab", { name: /Inbox/ }));
    expect(
      (slot.getByLabelText("Your answer") as HTMLTextAreaElement).value,
    ).toBe("My pending answer");
    expect(slot.queryByRole("heading", { name: "Observed usage" })).toBeNull();
  });

  it("keeps repositories and Pause inside the panel and dismisses its menu with Escape", async () => {
    const o = overview();
    const command = vi.fn().mockResolvedValue({});
    const slot = mount({
      list: () => [],
      overview: () => o,
      command,
      inventory: () => [
        {
          id: "repo",
          name: "Repository",
          environments: [
            {
              id: "env",
              path: "/code/repo",
              hostId: "Linux",
              name: null,
              isWorktree: false,
              status: "ready",
              isDefaultHome: true,
            },
          ],
        },
        { id: "second", name: "Second repo", environments: [] },
      ],
    });
    await slot.findByRole("button", { name: "Initiative menu" });
    fireEvent.click(slot.getByRole("button", { name: "Initiative menu" }));
    fireEvent.click(slot.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0]![0].command).toEqual({
      action: "pause",
      paused: true,
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(slot.queryByRole("button", { name: "Pause" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Initiative menu" }));
    fireEvent.click(slot.getByRole("button", { name: "Repositories" }));
    expect(await slot.findByText("/code/repo")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Add a BB project" }));
    fireEvent.click(slot.getByRole("button", { name: "Second repo" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command.mock.calls[1]![0].command).toEqual({
      action: "edit",
      memberProjectIds: ["repo", "second"],
    });
    expect(slot.queryByRole("button", { name: "Files" })).toBeNull();
  });
  it("edits tasks and records only explicit updates through supported commands", async () => {
    const o = overview();
    const command = vi.fn().mockResolvedValue({});
    const slot = mount({ list: () => [], overview: () => o, command });
    await slot.findByRole("tab", { name: /Tasks/ });
    fireEvent.click(slot.getByRole("tab", { name: /Tasks/ }));
    fireEvent.click(slot.getByText("Result descriptions"));
    fireEvent.click(slot.getByRole("button", { name: "Edit task" }));
    const taskDetails = within(
      slot.getByText("Result descriptions").closest("details")!,
    );
    fireEvent.change(taskDetails.getByLabelText("Task title"), {
      target: { value: "Describe each result" },
    });
    fireEvent.change(slot.getByLabelText("Task summary"), {
      target: { value: "Explain the source match" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save task" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0]![0].command).toEqual({
      action: "task-update",
      task: "T2",
      title: "Describe each result",
      summary: "Explain the source match",
    });
    fireEvent.click(slot.getByRole("tab", { name: "Log" }));
    fireEvent.click(slot.getByText("Record an update"));
    fireEvent.change(slot.getByLabelText("Update summary"), {
      target: { value: "Accepted scope" },
    });
    fireEvent.change(slot.getByLabelText("Update details"), {
      target: { value: "Keep source links in the results" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Record update" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command.mock.calls[1]![0].command).toEqual({
      action: "update",
      summary: "Accepted scope",
      body: "Keep source links in the results",
    });
    expect(slot.queryByText(/turn ended|Tokens saved|Move \d/)).toBeNull();
  });

  it("uses keyboard tab navigation and reveals failed handover retry without starting it", async () => {
    const o = overview();
    o.project.coordinatorHandover = {
      state: "failed",
      reason: "Context",
      profile: "current effective profile",
      environment: null,
      detail: "Spawn refused",
      requestedAt: Date.now(),
    };
    const command = vi.fn();
    const slot = mount({ list: () => [], overview: () => o, command });
    const inbox = await slot.findByRole("tab", { name: /Inbox/ });
    fireEvent.keyDown(inbox, { key: "End" });
    expect(
      slot.getByRole("tab", { name: "Usage" }).getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(slot.getByRole("tab", { name: "Usage" }), {
      key: "ArrowRight",
    });
    expect(
      slot.getByRole("tab", { name: /Inbox/ }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(slot.getByText("Spawn refused")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Retry replacement" }));
    expect(slot.getByLabelText("Handoff checkpoint")).toBeTruthy();
    expect(slot.queryByRole("tab", { name: /Inbox/ })).toBeNull();
    expect(command).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(slot.queryByLabelText("Handoff checkpoint")).toBeNull();
    expect(slot.getByRole("tab", { name: /Inbox/ })).toBeTruthy();
  });

  it("retries unavailable repository inventory on demand without polling it", async () => {
    const o = overview();
    const inventory = vi
      .fn()
      .mockRejectedValueOnce(new Error("Inventory unavailable"))
      .mockResolvedValue([
        { id: "repo", name: "Repository", environments: [] },
      ]);
    const slot = mount({ list: () => [], overview: () => o, inventory });
    fireEvent.click(await slot.findByRole("tab", { name: "Context" }));
    await slot.findByText("Inventory unavailable");
    expect(inventory).toHaveBeenCalledTimes(1);
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(slot.queryByText("Inventory unavailable")).toBeNull(),
    );
    expect(inventory).toHaveBeenCalledTimes(2);
    fireEvent.click(slot.getByRole("tab", { name: "Context" }));
    expect(slot.getByText("Repository")).toBeTruthy();
    expect(inventory).toHaveBeenCalledTimes(2);
  });
});
