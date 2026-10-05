import { describe, expect, it } from "vitest";
import { findPanelTab, paramsWithTarget, sameJson, targetThreadParam } from "@/lib/panel-target";

describe("targetThreadParam", () => {
  it("reads a well-formed target and rejects everything else", () => {
    expect(targetThreadParam({ targetThreadId: "thr_abc123" })).toBe("thr_abc123");
    expect(targetThreadParam({ path: "a.ts", targetThreadId: "thr_x9" })).toBe("thr_x9");
    expect(targetThreadParam(null)).toBeNull();
    expect(targetThreadParam({})).toBeNull();
    expect(targetThreadParam({ targetThreadId: 42 })).toBeNull();
    expect(targetThreadParam({ targetThreadId: "../../etc" })).toBeNull();
    expect(targetThreadParam({ targetThreadId: "" })).toBeNull();
    expect(targetThreadParam(["thr_abc123"])).toBeNull();
    expect(targetThreadParam("thr_abc123")).toBeNull();
  });
});

describe("paramsWithTarget", () => {
  it("keeps unrelated params and writes the target", () => {
    expect(paramsWithTarget({ filter: "ts" }, "thr_own", "thr_w16")).toEqual({ filter: "ts", targetThreadId: "thr_w16" });
    expect(paramsWithTarget(null, "thr_own", "thr_w16")).toEqual({ targetThreadId: "thr_w16" });
  });

  it("stores the panel's own target as absence so the default tab is unchanged", () => {
    expect(paramsWithTarget({ targetThreadId: "thr_w16" }, "thr_own", "thr_own")).toBeNull();
    expect(paramsWithTarget({ filter: "ts", targetThreadId: "thr_w16" }, "thr_own", "thr_own")).toEqual({ filter: "ts" });
  });

  it("drops the old target's path and position when the target changes", () => {
    // `path`, `lineRange` and the diff `target` belong to the workspace they
    // were taken in; another workspace's identical relative path is a
    // different file and must not ride along.
    expect(paramsWithTarget({ path: "a.ts" }, "thr_own", "thr_w16")).toEqual({ targetThreadId: "thr_w16" });
    expect(paramsWithTarget({ path: "a.ts", lineRange: [1, 5], target: { type: "commit", sha: "abc1234" } }, "thr_own", "thr_w16"))
      .toEqual({ targetThreadId: "thr_w16" });
    expect(paramsWithTarget({ path: "a.ts", targetThreadId: "thr_w16" }, "thr_own", "thr_w21")).toEqual({
      targetThreadId: "thr_w21",
    });
    // Switching back home drops the foreign path too, so the tab returns to
    // the default params rather than pointing at a remembered foreign file.
    expect(paramsWithTarget({ path: "a.ts", targetThreadId: "thr_w16" }, "thr_own", "thr_own")).toBeNull();
  });

  it("keeps the path when it already belongs to the target being written", () => {
    expect(paramsWithTarget({ path: "a.ts", targetThreadId: "thr_w16" }, "thr_own", "thr_w16")).toEqual({
      path: "a.ts",
      targetThreadId: "thr_w16",
    });
  });
});

describe("sameJson", () => {
  it("compares structurally, ignoring key order", () => {
    expect(sameJson({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson(null, null)).toBe(true);
    expect(sameJson(null, {})).toBe(false);
  });
});

describe("findPanelTab", () => {
  const tabs = [
    { id: "t1", kind: "plugin-panel", pluginId: "editor", actionId: "files", paramsJson: null },
    { id: "t2", kind: "plugin-panel", pluginId: "editor", actionId: "files", paramsJson: '{"path":"a.ts","targetThreadId":"thr_w16"}' },
    { id: "t3", kind: "plugin-panel", pluginId: "editor", actionId: "changes", paramsJson: '{"targetThreadId":"thr_w16"}' },
    { id: "t4", kind: "plugin-panel", pluginId: "kanban", actionId: "files", paramsJson: '{"targetThreadId":"thr_w16"}' },
    { id: "t5", kind: "thread-info" },
  ];

  it("finds the one tab matching plugin, action and params", () => {
    expect(findPanelTab(tabs, { pluginId: "editor", actionId: "files", params: null })).toEqual(tabs[0]);
    expect(
      findPanelTab(tabs, {
        pluginId: "editor",
        actionId: "files",
        params: { targetThreadId: "thr_w16", path: "a.ts" },
      }),
    ).toEqual(tabs[1]);
    expect(findPanelTab(tabs, { pluginId: "editor", actionId: "changes", params: { targetThreadId: "thr_w16" } })).toEqual(tabs[2]);
  });

  it("misses rather than guessing: wrong plugin, wrong action, wrong params", () => {
    expect(findPanelTab(tabs, { pluginId: "kanban", actionId: "files", params: { targetThreadId: "thr_w16" } })).toEqual(tabs[3]);
    expect(findPanelTab(tabs, { pluginId: "editor", actionId: "files", params: { targetThreadId: "thr_w16" } })).toBeNull();
    expect(findPanelTab(tabs, { pluginId: "editor", actionId: "changes", params: { targetThreadId: "thr_w8" } })).toBeNull();
  });

  it("reports ambiguity instead of rewriting a sibling", () => {
    const dupes = [
      { id: "a", kind: "plugin-panel", pluginId: "editor", actionId: "files", paramsJson: '{"targetThreadId":"thr_w16"}' },
      { id: "b", kind: "plugin-panel", pluginId: "editor", actionId: "files", paramsJson: '{"targetThreadId":"thr_w16"}' },
    ];
    expect(findPanelTab(dupes, { pluginId: "editor", actionId: "files", params: { targetThreadId: "thr_w16" } })).toBe("ambiguous");
  });

  it("declines unparseable paramsJson rather than matching it as null and overwriting it", () => {
    const corrupt = [{ id: "t", kind: "plugin-panel", pluginId: "editor", actionId: "files", paramsJson: "{oops" }];
    expect(findPanelTab(corrupt, { pluginId: "editor", actionId: "files", params: null })).toBe("unreadable");
    expect(findPanelTab(corrupt, { pluginId: "editor", actionId: "files", params: { path: "a.ts" } })).toBe("unreadable");
  });

  it("declines when a same-action sibling is unreadable even if another tab matches", () => {
    const tabs = [
      { id: "ok", kind: "plugin-panel", pluginId: "editor", actionId: "files", paramsJson: '{"path":"a.ts"}' },
      { id: "bad", kind: "plugin-panel", pluginId: "editor", actionId: "files", paramsJson: "{oops" },
    ];
    // Either tab could be this panel instance; rewriting the matching one is
    // not provably safe, so the rewrite declines instead of guessing.
    expect(findPanelTab(tabs, { pluginId: "editor", actionId: "files", params: { path: "a.ts" } })).toBe("unreadable");
    // An unreadable tab of another action or plugin does not block the match.
    const otherAction = [tabs[0], { id: "bad2", kind: "plugin-panel", pluginId: "editor", actionId: "changes", paramsJson: "{oops" }];
    expect(findPanelTab(otherAction, { pluginId: "editor", actionId: "files", params: { path: "a.ts" } })).toEqual(tabs[0]);
  });
});
