import { describe, it, expect } from "vitest";
import { compareThreads, STATUSES, statusOf, threadTitle } from "../lib/status";
import { parseState } from "../lib/client-state";
import { thread } from "./fixtures";
import { relativeAge } from "../lib/time";

describe("relative update age", () => {
  it.each([
    [0, "now"],
    [60_000, "1m"],
    [3_600_000, "1h"],
    [86_400_000, "1d"],
    [366 * 86_400_000, "1y"],
    [-60_000, "now"],
  ] as const)("formats an age of %s milliseconds", (age, label) =>
    expect(relativeAge(0, age)).toBe(label),
  );
});

describe("status policy", () => {
  it("uses the requested display order", () =>
    expect(STATUSES).toEqual([
      "attention",
      "unread",
      "working",
      "draft",
      "done",
    ]));
  it("does not call recent idle threads working", () =>
    expect(statusOf(thread({ updatedAt: Date.now() }))).toBe("done"));
  it("puts pending input ahead of running, unread, and draft", () =>
    expect(
      statusOf(
        thread({
          hasPendingInteraction: true,
          indicator: "runtime",
          isUnread: true,
        }),
        true,
      ),
    ).toBe("attention"));
  it.each(["waiting-for-input", "unread-error"] as const)(
    "recognizes %s",
    (indicator) => expect(statusOf(thread({ indicator }))).toBe("attention"),
  );
  it.each([
    "runtime",
    "background-agent",
    "background-command",
    "workflow",
    "plan-mode",
    "goal",
    "working-draft",
  ] as const)("recognizes live %s even with an unread flag", (indicator) =>
    expect(statusOf(thread({ indicator, isUnread: true }), true)).toBe(
      "working",
    ),
  );
  it.each([
    "workflows",
    "backgroundAgents",
    "backgroundCommands",
    "planMode",
    "goals",
  ] as const)("uses live %s counts", (activity) =>
    expect(
      statusOf(thread({ activity: { ...thread().activity, [activity]: 1 } })),
    ).toBe("working"),
  );
  it("follows running -> unread -> read -> draft -> cleared", () => {
    const t = thread({ indicator: "runtime", isUnread: true });
    expect(statusOf(t)).toBe("working");
    t.indicator = "unread-success";
    expect(statusOf(t, true)).toBe("unread");
    t.indicator = "none";
    t.isUnread = false;
    expect(statusOf(t)).toBe("done");
    expect(statusOf(t, true)).toBe("draft");
    expect(statusOf(t, false)).toBe("done");
  });
  it("sorts pins then updated date with a stable tie break", () => {
    const rows = [
      thread({ id: "b" }),
      thread({ id: "a" }),
      thread({ id: "recent", updatedAt: 500 }),
      thread({ id: "pin", isPinned: true }),
    ];
    expect(rows.sort(compareThreads).map((t) => t.id)).toEqual([
      "pin",
      "recent",
      "a",
      "b",
    ]);
  });
  it("sorts by the requested timestamp, not by attention events", () => {
    const a = thread({
      id: "a",
      createdAt: 200,
      updatedAt: 200,
      latestAttentionAt: 900,
    });
    const b = thread({ id: "b", createdAt: 100, updatedAt: 300 });
    expect(
      [a, b].sort((x, y) => compareThreads(x, y, "created")).map((t) => t.id),
    ).toEqual(["a", "b"]);
    expect(
      [a, b].sort((x, y) => compareThreads(x, y, "updated")).map((t) => t.id),
    ).toEqual(["b", "a"]);
  });
  it("uses fallback titles", () =>
    expect(
      threadTitle(thread({ title: " ", titleFallback: "First prompt" })),
    ).toBe("First prompt"));
});

describe("client storage boundary", () => {
  it("loads old preferences without retaining the removed project filter", () => {
    const state = parseState(
      JSON.stringify({
        groupBy: "project",
        projectId: "old-project",
        collapsed: ["status:done"],
        drafts: ["thread:1"],
      }),
    );
    expect(state.sortBy).toBe("updated");
    expect(state.groupBy).toBe("project");
    expect(state.collapsed).toEqual(["status:done"]);
    expect(state.drafts).toEqual(["thread:1"]);
    expect(state).not.toHaveProperty("projectId");
  });
  it.each([null, "bad", 123])(
    "uses updated date for an invalid sort value: %s",
    (sortBy) => {
      expect(parseState(JSON.stringify({ sortBy })).sortBy).toBe("updated");
    },
  );
  it.each([null, "{", "null", "42"])(
    "accepts missing or corrupt storage: %s",
    (raw) => expect(parseState(raw).groupBy).toBe("status"),
  );
  it("validates fields and discards unknown statuses and draft keys", () => {
    expect(
      parseState(
        JSON.stringify({
          hidden: ["done", "bad", "done", null],
          drafts: ["thread:1", "secret", 2],
          collapsed: false,
          groupBy: "bad",
        }),
      ),
    ).toEqual({
      hidden: ["done"],
      drafts: ["thread:1"],
      collapsed: [],
      expandedArchives: [],
      groupBy: "status",
      sortBy: "updated",
    });
  });
});
