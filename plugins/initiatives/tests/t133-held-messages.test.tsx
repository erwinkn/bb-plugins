// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { projectFixture } from "./fake-native";
import { HELD_AFTER_MS, notDeliveredMessages, type QueuedRow } from "../lib/not-delivered";
import type { LiveThread } from "../lib/overview";
await loadPluginApp(() => import("../app"));
const { Dashboard } = await import("../app");
const slots: ReturnType<typeof renderSlot>[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.unmount(); cleanup(); });

// T133: messages BB holds for an Initiative's members with nothing running to deliver them.
const NOW = 1_800_000_000_000;
const OLD = NOW - HELD_AFTER_MS - 1_000;
const text = (t: string) => [{ type: "text" as const, text: t, mentions: [] }];
const row = (over: Partial<QueuedRow> & { id: string; threadId: string }): QueuedRow => ({
  content: text("Initiative · Marbre · From coordinator\n\nA is fine: put the skip flag in."),
  createdAt: OLD, updatedAt: OLD, waitingOn: { kind: "thread-busy" }, failureReason: null,
  ...over,
} as QueuedRow);
const live = (entries: Record<string, Partial<LiveThread>>) =>
  new Map(Object.entries(entries).map(([id, t]) => [id, { status: "idle", archived: false, title: null, ...t } as LiveThread]));
const targets = new Map([["thr_coord", "the coordinator"], ["thr_w47", "W47"], ["thr_old", "a former coordinator"]]);

describe("T133 which queued messages are held", () => {
  it("names a row waiting behind a turn that ended, on an idle or failed member", () => {
    const held = notDeliveredMessages(
      [row({ id: "qmsg_b", threadId: "thr_w47", createdAt: OLD + 1 }), row({ id: "qmsg_a", threadId: "thr_coord", waitingOn: { kind: "turn-starting" } })],
      targets, live({ thr_w47: { status: "error" }, thr_coord: {} }), NOW);
    expect(held).toEqual([
      { id: "qmsg_a", threadId: "thr_coord", target: "the coordinator", queuedAt: OLD, preview: "Initiative · Marbre · From coordinator A is fine: put the skip flag in.",
        reason: "The coordinator is idle, but BB is holding this, usually because its turn was stopped by hand." },
      expect.objectContaining({ id: "qmsg_b", target: "W47", reason: "W47's last turn failed, and BB has not sent this since." }),
    ]);
  });

  it("leaves rows BB can still move on its own, or holds on purpose", () => {
    const rows = [
      row({ id: "qmsg_fresh", threadId: "thr_coord", updatedAt: NOW - 60_000 }),
      row({ id: "qmsg_running", threadId: "thr_w47" }),
      row({ id: "qmsg_clock", threadId: "thr_old", waitingOn: { kind: "time" } }),
      row({ id: "qmsg_limiter", threadId: "thr_old", waitingOn: { kind: "plugin", pluginId: "pool", reason: "At capacity" } as never }),
      row({ id: "qmsg_stranger", threadId: "thr_user" }),
      row({ id: "qmsg_unknown", threadId: "thr_old" }),
    ];
    const facts = live({ thr_coord: {}, thr_w47: { status: "active" }, thr_user: {} });
    facts.set("thr_old", { status: "idle", archived: false, title: null });
    expect(notDeliveredMessages(rows.slice(0, 5), targets, facts, NOW)).toEqual([]);
    facts.delete("thr_old");
    expect(notDeliveredMessages(rows.slice(5), targets, facts, NOW)).toEqual([]);
  });

  it("names a row BB gave up on at once, whatever the thread is doing, but never one on an archived thread", () => {
    const failed = row({ id: "qmsg_f", threadId: "thr_old", updatedAt: NOW, failureReason: "Queued message claim expired before it could be sent" });
    expect(notDeliveredMessages([failed], targets, live({ thr_old: { status: "active" } }), NOW)).toEqual([
      expect.objectContaining({ target: "a former coordinator", reason: "BB stopped trying to send this to a former coordinator: Queued message claim expired before it could be sent" }),
    ]);
    expect(notDeliveredMessages([failed], targets, live({ thr_old: { archived: true } }), NOW)).toEqual([]);
  });
});

describe("T133 sending or removing a held message", () => {
  async function held() {
    const { f, project } = await projectFixture();
    f.idle("coordinator");
    const at = Date.now() - HELD_AFTER_MS - 1_000;
    f.queued.set("coordinator", [{ id: "qmsg_held", content: text("From W2: the fix is in."), createdAt: at, updatedAt: at, waitingOn: { kind: "thread-busy" }, failureReason: null }]);
    return { f, project };
  }

  it("shows it under Not delivered and sends it once, as BB's Send now", async () => {
    const { f, project } = await held();
    const o = await f.overview(project.id, "summary");
    expect(o.notDelivered).toEqual([expect.objectContaining({ id: "qmsg_held", threadId: "coordinator", target: "the coordinator" })]);
    expect(await f.perform(project.id, { action: "queued-message", thread: "coordinator", message: "qmsg_held", operation: "send" } as never, "user", null))
      .toEqual({ outcome: "sent" });
    expect(f.sendQueued.mock.calls).toEqual([[{ threadId: "coordinator", queuedMessageId: "qmsg_held", mode: "auto" }]]);
    expect((await f.overview(project.id, "summary")).notDelivered).toEqual([]);
    // A repeat after a lost response finds the row gone and sends nothing.
    expect(await f.perform(project.id, { action: "queued-message", thread: "coordinator", message: "qmsg_held", operation: "send" } as never, "user", null))
      .toMatchObject({ outcome: "gone" });
    expect(f.sendQueued).toHaveBeenCalledTimes(1);
    expect(f.store.activity(project.id, 5).map((a: { summary: string }) => a.summary)).toContain("You sent a message BB was holding for the coordinator (qmsg_held)");
  });

  it("removes it without sending, and refuses agents and threads outside the Initiative", async () => {
    const { f, project } = await held();
    await expect(f.perform(project.id, { action: "queued-message", thread: "coordinator", message: "qmsg_held", operation: "delete" } as never, "coordinator", "coordinator"))
      .rejects.toThrow(/Only the user/);
    await expect(f.perform(project.id, { action: "queued-message", thread: "thr_elsewhere", message: "qmsg_held", operation: "delete" } as never, "user", null))
      .rejects.toThrow(/not this Initiative's coordinator/);
    expect(await f.perform(project.id, { action: "queued-message", thread: "coordinator", message: "qmsg_held", operation: "delete" } as never, "user", null))
      .toEqual({ outcome: "deleted" });
    expect(f.queued.get("coordinator")).toEqual([]);
    expect(f.sendQueued).not.toHaveBeenCalled();
  });

  it("offers Send now and Remove in the Inbox", async () => {
    const { f, project } = await held();
    const commands: unknown[] = [];
    let o = await f.overview(project.id, "summary");
    const slot = renderSlot({ component: Dashboard }, { projectId: project.id }, {
      rpc: {
        overview: async () => o,
        command: async ({ command }: any) => {
          commands.push(command);
          const result = await f.perform(project.id, command, "user", null);
          o = await f.overview(project.id, "summary");
          return result;
        },
      },
    } as never);
    slots.push(slot);
    const section = await slot.findByRole("region", { name: "Not delivered" });
    expect(section.textContent).toContain("The coordinator is idle, but BB is holding this");
    expect(section.textContent).toContain("From W2: the fix is in.");
    fireEvent.click(slot.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(commands).toEqual([{ action: "queued-message", thread: "coordinator", message: "qmsg_held", operation: "send" }]));
    expect(f.sendQueued).toHaveBeenCalledTimes(1);
  });
});
