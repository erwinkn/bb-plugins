// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

await loadPluginApp(() => import("../app"));
const { GithubBody, GithubHtml } = await import("./github-html");

function renderHtml(html: string) {
  return renderSlot({ component: () => <GithubHtml html={html} /> }, {});
}

describe("GithubHtml", () => {
  it("renders bot-style HTML tables and links like GitHub does", () => {
    const slot = renderHtml(
      '<p dir="auto">The latest updates. <a href="https://vercel.link/github-learn-more">Learn more</a></p>' +
        '<table><thead><tr><th>Project</th><th>Updated</th></tr></thead>' +
        '<tbody><tr><td><a href="https://vercel.com/x"><sup>🔵</sup></a> pulse-ui</td>' +
        '<td><relative-time datetime="2026-09-13T20:08:00Z">Sep 13, 2026</relative-time></td></tr></tbody></table>',
    );
    expect(slot.getByRole("table")).toBeTruthy();
    expect(slot.getByText("pulse-ui")).toBeTruthy();
    const link = slot.getByRole("link", { name: "Learn more" });
    expect(link.getAttribute("href")).toBe("https://vercel.link/github-learn-more");
    const time = slot.container.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe("2026-09-13T20:08:00Z");
    expect(time?.textContent).toMatch(/ago$/);
    // No raw markup leaks as text.
    expect(slot.container.textContent).not.toContain("<table>");
    expect(slot.container.textContent).not.toContain("<relative-time");
    expect(slot.container.textContent).not.toContain("<sup>");
    slot.unmount();
  });

  it("drops active content and unsafe hrefs", () => {
    const slot = renderHtml(
      '<p>hi</p><script>alert(1)</script><style>x{}</style><a href="javascript:alert(1)">click</a><iframe src="https://evil.test"></iframe>',
    );
    expect(slot.container.textContent).not.toContain("alert(1)");
    expect(slot.container.textContent).not.toContain("x{}");
    expect(slot.queryByRole("link")).toBeNull();
    expect(slot.container.querySelector("iframe")).toBeNull();
    // The unsafe anchor unwraps to its label text.
    expect(slot.container.textContent).toContain("click");
    slot.unmount();
  });

  it("unwraps unknown wrappers like g-emoji and keeps details/summary", () => {
    const slot = renderHtml('<p><g-emoji>🚀</g-emoji> ship</p><details><summary>More</summary><p>hidden</p></details>');
    expect(slot.container.textContent).toContain("🚀 ship");
    expect(slot.container.querySelector("details > summary")).toBeTruthy();
    expect(slot.getByText("hidden")).toBeTruthy();
    slot.unmount();
  });

  it("renders GitHub task-list checkboxes disabled", () => {
    const slot = renderHtml('<ul><li><input type="checkbox" checked> done</li></ul>');
    const box = slot.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    slot.unmount();
  });
});

describe("GithubBody", () => {
  it("prefers bodyHtml and falls back to markdown", () => {
    const html = renderSlot({ component: () => <GithubBody body="**raw**" bodyHtml="<p><strong>cooked</strong></p>" /> }, {});
    expect(html.getByText("cooked")).toBeTruthy();
    html.unmount();

    const md = renderSlot({ component: () => <GithubBody body="**raw**" bodyHtml={null} /> }, {});
    expect(md.container.querySelector("strong")?.textContent).toBe("raw");
    md.unmount();
  });
});
