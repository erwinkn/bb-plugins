// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { MemoryStatus } from "../lib/memory";
await loadPluginApp(() => import("../app"));
const { MemoryPill, MemoryPanel } = await import("../app");
afterEach(() => cleanup());

const status = (patch: Partial<MemoryStatus> = {}): MemoryStatus => ({
  scope: { id: "initiatives:prj_1", owner: "initiatives" },
  mode: "regular",
  compactTokens: 300_000,
  compactTokensOverride: null,
  threads: [{ threadId: "coord", title: "bb-plugins · coordinator", providerId: "claude-code", state: "current", askedAt: 1, askedProtocol: 4, compactedAt: null, compactError: null }],
  log: { messages: 6120, bytes: 3_051_433 },
  tree: { summarized: 6120, nodes: 12_189, total: 12_230, fallbacks: 0, failed: 0, viewBytes: 90_000, memoryViewBytes: 24_000, state: "idle", detail: null, until: null },
  cost: { calls: 3674, tries: 7225, inputTokens: 53_840_761, cachedTokens: 40_000_000, outputTokens: 900_000, usd: 3.46, callSeconds: 43_870 },
  problems: [],
  ...patch,
});
const props = { threadId: "coord", projectId: "p", isCompactViewport: false };

describe("T145 the memory pill", () => {
  it("shows only on a thread with memory, with its mode, and flags a problem", async () => {
    const none = renderSlot({ component: MemoryPill }, { ...props, threadId: "plain" }, { rpc: { status: async () => null } });
    await waitFor(() => expect(none.container.textContent).toBe(""));
    const s = renderSlot({ component: MemoryPill }, props, { rpc: { status: async () => status({ mode: "optchat", problems: ["OptChat cannot run in \"Talk\" (codex)"] }) } });
    expect(await s.findByRole("button", { name: "Memory: OptChat, needs attention. Change it" })).toBeTruthy();
    expect(s.getByRole("status").textContent).toContain("OptChat cannot run");
  });

  it("switches from the radio group; a refusal says why and keeps the saved mode, focus included (D458, D460)", async () => {
    let saved: MemoryStatus = status();
    const configure = vi.fn(async (input: unknown) => {
      const { mode } = input as { mode?: MemoryStatus["mode"] };
      if (mode === "optchat") throw new Error("OptChat runs on Claude Code only for now (T146): \"Talk\" runs on codex.");
      saved = status({ mode: mode ?? saved.mode });
      return saved;
    });
    const s = renderSlot({ component: MemoryPill }, props, { rpc: { status: async () => saved, configure } });
    const group = await within(s.container).findByRole("radiogroup", { name: "Memory mode" });
    const radio = (name: string) => within(group).getByRole("radio", { name });
    expect(radio("Regular").getAttribute("aria-checked")).toBe("true");
    expect(radio("Regular").tabIndex).toBe(0);
    expect(radio("Hybrid").tabIndex).toBe(-1);
    radio("Regular").focus();
    fireEvent.keyDown(group, { key: "ArrowRight" });
    await waitFor(() => expect(radio("Hybrid").getAttribute("aria-checked")).toBe("true"));
    expect(configure).toHaveBeenLastCalledWith({ threadId: "coord", mode: "hybrid" });
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(await within(s.container).findByRole("alert")).toHaveProperty("textContent", "OptChat runs on Claude Code only for now (T146): \"Talk\" runs on codex.");
    await waitFor(() => expect(radio("Hybrid").getAttribute("aria-checked")).toBe("true"));
    expect(document.activeElement).toBe(radio("Hybrid"));
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
