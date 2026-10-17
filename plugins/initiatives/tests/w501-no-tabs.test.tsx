// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
// Installs the test runtime the app module needs, and collects what the SDK's registry sees.
const collected = await loadPluginApp(() => import("../app"));

// W501 (R6): the coordinator's header keeps its Initiative button, and no thread shows Discussion
// tabs: the app registers no tab group even on a BB whose fork offers the slot.
describe("W501 no Discussion tabs", () => {
  it("registers the header action and no thread tab group", async () => {
    const app = await import("../app");
    expect(app).not.toHaveProperty("useInitiativeTabs");
    const registered: string[] = [];
    // A BB that offers every slot, the fork's experimental_threadGroupTabs included.
    const slots = new Proxy({}, { get: (_, name) => () => void registered.push(String(name)) });
    (app.default as unknown as { setup(api: { slots: unknown }): void }).setup({ slots });
    expect(registered).toContain("experimental_threadHeaderAction");
    expect(registered).not.toContain("experimental_threadGroupTabs");
    expect(collected.threadPanelActions.map((a) => a.id)).toEqual(["initiative-overview"]);
  });
});
