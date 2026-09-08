// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPluginApp,
  mountPluginContentScripts,
} from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

function fixture() {
  document.body.innerHTML = `
    <style>
      .bb-sidebar-hover-actions { display: flex; }
      [data-plugin-nav-sidebar-accessory] { opacity: 0; }
    </style>
    <div data-sidebar-navigation-item="__bb__/automations">
      <button type="button">Automations</button>
      <div class="bb-sidebar-hover-actions">automations menu</div>
    </div>
    <div data-sidebar-navigation-item="voice-mode/sessions">
      <button type="button">Voice</button>
      <span data-plugin-nav-sidebar-accessory="">live</span>
      <div class="bb-sidebar-hover-actions">voice menu</div>
    </div>
    <div data-sidebar-navigation-item="notes/home">
      <button type="button">Notes</button>
      <div class="bb-sidebar-hover-actions">notes menu</div>
    </div>
    <div data-sidebar-thread-id="thr_1">
      <button type="button">A thread</button>
      <div class="bb-sidebar-hover-actions">thread menu</div>
    </div>
    <div data-plugin-nav-customize-item="voice-mode/sessions">
      <div class="bb-sidebar-hover-actions">customize control</div>
    </div>
  `;
}

function displayOf(selector: string) {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(selector);
  return getComputedStyle(element).display;
}

function opacityOf(selector: string) {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(selector);
  return getComputedStyle(element).opacity;
}

describe("plugin nav menus", () => {
  afterEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  it("hides the ellipsis on every plugin nav row and leaves other menus", async () => {
    fixture();
    const scripts = await mountPluginContentScripts(app, {
      pluginId: "erwin-plugin-nav",
      generation: 1,
    });
    try {
      expect(displayOf('[data-sidebar-navigation-item="__bb__/automations"] > .bb-sidebar-hover-actions')).toBe("none");
      expect(displayOf('[data-sidebar-navigation-item="voice-mode/sessions"] > .bb-sidebar-hover-actions')).toBe("none");
      expect(displayOf('[data-sidebar-navigation-item="notes/home"] > .bb-sidebar-hover-actions')).toBe("none");
      expect(displayOf('[data-sidebar-thread-id="thr_1"] > .bb-sidebar-hover-actions')).toBe("flex");
      expect(displayOf('[data-plugin-nav-customize-item] > .bb-sidebar-hover-actions')).toBe("flex");
      expect(opacityOf("[data-plugin-nav-sidebar-accessory]")).toBe("1");
    } finally {
      await scripts.lifecycle.dispose();
    }
    expect(document.querySelector("[data-hide-plugin-nav]")).toBeNull();
    expect(displayOf('[data-sidebar-navigation-item="voice-mode/sessions"] > .bb-sidebar-hover-actions')).toBe("flex");
  });
});
