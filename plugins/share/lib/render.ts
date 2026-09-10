import { Marked } from "marked";
import type { RenderItem, Visibility } from "./model";
import { redact } from "./redact";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
const safeText = (text: string) => escapeHtml(redact(text));
const markdown = new Marked({
  gfm: true, breaks: false, async: false,
  renderer: {
    html({ text }) { return escapeHtml(text); },
    image() { return ""; },
    link({ href, tokens }) {
      // Even rejected links must render nested tokens so images are dropped.
      const label = this.parser.parseInline(tokens);
      // Validate the literal scheme before any HTML entity decoding can occur.
      if (!/^(?:https?:|mailto:)/i.test(href) || /[\u0000-\u0020\u007f]/.test(href)) return label;
      try {
        const url = new URL(href);
        if (!["http:", "https:", "mailto:"].includes(url.protocol)) return label;
      } catch { return label; }
      return `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow">${label}</a>`;
    },
  },
});

const STYLE = `:root{color-scheme:light dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.65;color:#20242b;background:#f8f9fb}*{box-sizing:border-box}body{margin:0;padding:32px 18px}main{max-width:720px;margin:auto}h1{line-height:1.2;font-size:clamp(1.6rem,5vw,2.2rem);overflow-wrap:anywhere}header{margin-bottom:32px}.label,footer,.detail{font-size:.85rem;color:#596273}.message,details{margin:16px 0;padding:18px 20px;border:1px solid #dce1e8;border-radius:12px;background:#fff;overflow-wrap:anywhere}.user{background:#eef3fb}.role{font-size:.8rem;font-weight:650;letter-spacing:.03em}.message>:last-child{margin-bottom:0}a{color:#235aa6;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf0f4;padding:14px;border-radius:7px;font-size:.85rem}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}summary{cursor:pointer;font-weight:600}blockquote{margin-left:0;padding-left:16px;border-left:3px solid #b7c4d6}table{display:block;max-width:100%;overflow:auto;border-collapse:collapse}td,th{border:1px solid #aab3c0;padding:6px 10px}.notice{padding:12px 16px;border:1px solid #c89a39;border-radius:8px;background:#fff7dd}footer{margin-top:32px}@media(prefers-color-scheme:dark){:root{color:#e4e8ee;background:#171a20}.message,details{background:#20252e;border-color:#394250}.user{background:#232f43}.label,footer,.detail{color:#adb8c8}a{color:#9bc4ff}pre{background:#151b24}.notice{background:#352e1a;border-color:#9c7b38}}@media(max-width:480px){body{padding:20px 12px}.message,details{padding:14px}}`;

function document(title: string, body: string): string {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${safeText(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function renderPage(input: {
  title: string; mode: Visibility; unverified: boolean; truncated: boolean; items: RenderItem[]; generatedAt: number;
}): string {
  const items = input.items.map((item) => {
    if (item.kind === "message") {
      return `<article class="message ${item.role}"><div class="role">${item.role === "user" ? "User" : "Assistant"}</div>${markdown.parse(redact(item.text))}</article>`;
    }
    const output = redact(item.output ?? "");
    const limit = 100_000;
    return `<details><summary>${safeText(item.title)} <span class="label">${safeText(item.status)}</span></summary>${item.detail ? `<p class="detail">${safeText(item.detail)}</p>` : ""}${output ? `<pre>${escapeHtml(output.slice(0, limit))}</pre>${output.length > limit ? `<p class="detail">Tool output truncated at ${limit} characters; ${output.length - limit} characters omitted.</p>` : ""}` : ""}</details>`;
  }).join("\n");
  return document(input.title, `<header><p class="label">${input.mode === "access" ? "Shared with sign-in" : "Public link"}</p><h1>${safeText(input.title)}</h1></header>${input.unverified ? '<p class="notice">Unverified mode: Access JWT check is disabled</p>' : ""}${input.truncated ? '<p class="notice">This thread is truncated; some older rows or tool details are omitted.</p>' : ""}${items}<footer>Read-only thread · Generated ${safeText(new Date(input.generatedAt).toISOString())} · Refresh to see new messages.</footer>`);
}

export function renderStatusPage(kind: "signin" | "forbidden", details: { email?: string | null } = {}): string {
  return kind === "signin"
    ? document("Sign-in required", "<h1>Sign-in required</h1><p>Sign in through Cloudflare Access to view this thread.</p>")
    : document("Access not granted", `<h1>Access not granted</h1><p>The owner has not granted access to the signed-in email: <strong>${safeText(details.email ?? "No email claim available")}</strong>.</p>`);
}
