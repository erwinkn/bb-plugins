import { describe, expect, it } from "vitest";
import { renderPage, renderStatusPage } from "../lib/render";
import { rowToItem } from "../server/timeline";
import { rows, NOW } from "./fixtures";

function render(text: string) {
  return renderPage({ title: "Thread <title>", mode: "public", unverified: false, truncated: false, generatedAt: NOW, items: [{ kind: "message", role: "user", text, at: NOW }] });
}
describe("safe rendering", () => {
  it.each([false, true])("snapshots the timeline with includeTools=%s", (includeTools) => {
    const items = rows.flatMap((row) => { const item = rowToItem(row, includeTools); return item ? [item] : []; });
    const html = renderPage({ title: "Sharing <demo>", mode: "access", unverified: false, truncated: false, items, generatedAt: NOW });
    expect(html).toMatchSnapshot();
    expect(html.includes("<details>")).toBe(includeTools);
    expect(html).not.toMatch(/SYSTEM PRIVATE|private\.png|private\.txt|abcdefghijklmnop/);
    expect(html).toContain("<strong>sharing</strong>");
  });
  it("escapes raw HTML and drops Markdown images", () => {
    const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n![private](https://example.com/a.png)');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).not.toMatch(/<script|<img|example\.com\/a\.png/);
    expect(html).toContain("<title>Thread &lt;title&gt;</title>");
  });
  it.each(["javascript:alert%281%29", "data:text/html,evil", "file:///etc/passwd", "//evil.test", "java&#x73;cript:evil", "javascript&colon;evil", "vbscript:evil"])("renders unsafe link %s as text", (url) => {
    const html = render(`[Click me](${url})`);
    expect(html).toContain("Click me"); expect(html).not.toContain("<a ");
  });
  it.each(["http://example.com", "https://example.com/a?x=1&y=2", "mailto:person@example.com"])("allows %s with protective rel", (url) => {
    expect(render(`[Link](${url})`)).toContain('rel="noopener noreferrer nofollow"');
  });
  it("redacts title, command, detail, status, and output before truncation", () => {
    const secret = "sk-abcdefghijklmnop";
    const html = renderPage({ title: secret, mode: "public", unverified: true, truncated: true, generatedAt: NOW,
      items: [{ kind: "tool", title: secret, detail: secret, status: secret, output: "x".repeat(19_999) + secret + "y".repeat(30), at: NOW }] });
    expect(html).not.toContain(secret);
    expect(html).toContain("Unverified mode: Access JWT check is disabled");
    expect(html).toContain("This thread is truncated");
    expect(html).toContain("Tool output truncated at 20000 characters");
  });
  it("escapes the forbidden email and gives a content-free sign-in page", () => {
    expect(renderStatusPage("forbidden", { email: '<img src=x>@example.com' })).not.toContain("<img");
    expect(renderStatusPage("forbidden", { email: "person@example.com" })).toContain("person@example.com");
    expect(renderStatusPage("signin")).toContain("Sign-in required");
  });
});
