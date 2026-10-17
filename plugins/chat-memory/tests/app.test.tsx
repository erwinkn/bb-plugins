// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { MemoryStatus } from "../lib/memory";
const registrations = await loadPluginApp(() => import("../app"));
const { MemoryPanel } = await import("../app");
afterEach(() => cleanup());

const status = (patch: Partial<MemoryStatus> = {}): MemoryStatus => ({
  scope: { id: "initiatives:prj_1", owner: "initiatives" },
  mode: "optchat",
  compactTokens: 0,
  compactTokensOverride: null,
  threads: [{ threadId: "coord", title: "bb-plugins · coordinator", providerId: "claude-code", compactedAt: null, compactError: null }],
  log: { messages: 6120, bytes: 3_051_433 },
  tree: { summarized: 6120, nodes: 12_189, total: 12_230, fallbacks: 0, failed: 0, viewBytes: 90_000, memoryViewBytes: 24_000, state: "idle", detail: null, until: null },
  cost: { calls: 3674, tries: 7225, inputTokens: 53_840_761, cachedTokens: 40_000_000, outputTokens: 900_000, usd: 3.46, callSeconds: 43_870 },
  problems: [],
  ...patch,
});
const props = { threadId: "coord", projectId: "p", isCompactViewport: false };

describe("R3 the memory has no switch", () => {
  it("registers the Memory panel only: no thread header entry", async () => {
    expect(registrations.threadHeaderActions).toEqual([]);
    expect(registrations.threadPanelActions.map((a) => a.id)).toEqual(["memory"]);
    expect("MemoryPill" in (await import("../app"))).toBe(false);
  });

  it("shows a coordinator's mode as a fact, with a problem flagged and no radio group or limit editor", async () => {
    const s = renderSlot({ component: MemoryPanel }, { threadId: "coord", params: null }, { rpc: { status: async () => status({ mode: "optchat", compactTokens: 0, problems: ["OptChat cannot run in \"Talk\" (codex)"] }) } });
    expect((await s.findByRole("status")).textContent).toContain("OptChat cannot run");
    expect(s.getByText("OptChat")).toBeTruthy();
    expect(s.container.textContent).toContain("Every Adventure coordinator uses it");
    expect(s.queryByRole("radiogroup")).toBeNull();
    expect(s.queryByRole("radio")).toBeNull();
    expect(s.queryByText("Compaction limit (tokens)")).toBeNull();
  });

  it("a Regular memory keeps its compaction limit, and still no mode switch", async () => {
    const s = renderSlot({ component: MemoryPanel }, { threadId: "coord", params: null }, { rpc: { status: async () => status({ scope: { id: "chat-memory:coord", owner: "chat-memory" }, mode: "regular" }) } });
    expect(await s.findByText("Compaction limit (tokens)")).toBeTruthy();
    expect(s.queryByRole("radiogroup")).toBeNull();
  });
});

describe("T145 the Memory panel", () => {
  it("turns memory on for a thread without any, and shows a memory's state", async () => {
    let saved: MemoryStatus | null = null;
    const configure = vi.fn(async () => (saved = status({ scope: { id: "chat-memory:coord", owner: "chat-memory" } })));
    const s = renderSlot({ component: MemoryPanel }, { threadId: "coord", params: null }, { rpc: { status: async () => saved, configure } });
    fireEvent.click(await s.findByRole("button", { name: "Turn memory on" }));
    await waitFor(() => expect(configure).toHaveBeenCalledWith({ threadId: "coord" }));
    expect(await s.findByText(/6,120 messages/)).toBeTruthy();
    expect(s.getByText("this thread")).toBeTruthy();
    expect(s.getByRole("button", { name: "Turn memory off" })).toBeTruthy();
  });
});
