// Renders GitHub's `body_html` (fetched with Accept: application/vnd.github.full+json)
// as React. The HTML is already sanitized server-side by GitHub; this adds a
// second whitelist pass anyway because the payload is still untrusted remote
// content: only known tags and attributes become elements, everything unknown
// is unwrapped to its children, and active content is dropped. `<relative-time>`
// becomes a relative timestamp and link reference definitions never reach
// body_html at all, so bot comments (vercel, socket-security) render as they do
// on github.com.
import { useMemo, type ReactNode } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { relativeTime } from "./shared";
import { Markdown } from "./markdown-lite";

const HEADING_CLASSES = ["text-lg font-semibold", "text-base font-semibold", "text-sm font-semibold"];

function safeHref(href: string | null): string | null {
  if (href === null) return null;
  const trimmed = href.trim();
  if (trimmed.startsWith("#")) return trimmed;
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return trimmed;
  return null;
}

function numericAttribute(element: Element, name: string): number | undefined {
  const raw = element.getAttribute(name);
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

function tableCellAlign(element: Element): string | undefined {
  const align = element.getAttribute("align");
  if (align === "center" || align === "right") return `text-${align}`;
  return undefined;
}

/** Convert one sanitized source node to React. */
function renderNode(node: Node, key: number): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const element = node as Element;
  const tag = element.localName;
  const children = () => [...element.childNodes].map((child, index) => renderNode(child, index));

  switch (tag) {
    // Active or meaningless content: dropped with its children.
    case "script":
    case "style":
    case "iframe":
    case "object":
    case "embed":
    case "form":
    case "link":
    case "meta":
    case "button":
    case "select":
    case "textarea":
      return null;
    case "a": {
      const href = safeHref(element.getAttribute("href"));
      if (href === null) return children();
      return (
        <UrlLink key={key} href={href} className="text-primary underline underline-offset-2">
          {children()}
        </UrlLink>
      );
    }
    case "img": {
      const src = element.getAttribute("src") ?? "";
      if (!/^https:\/\//i.test(src)) return element.getAttribute("alt") ?? null;
      return (
        <img
          key={key}
          src={src}
          alt={element.getAttribute("alt") ?? ""}
          width={numericAttribute(element, "width")}
          height={numericAttribute(element, "height")}
          loading="lazy"
          className="my-1 inline-block h-auto max-w-full rounded-md border border-border"
        />
      );
    }
    case "relative-time":
    case "time": {
      const datetime = element.getAttribute("datetime") ?? "";
      const label = relativeTime(datetime);
      return (
        <time key={key} dateTime={datetime} title={datetime} className="whitespace-nowrap">
          {label === "" ? children() : label}
        </time>
      );
    }
    case "p":
      return (
        <p key={key} className="break-words">
          {children()}
        </p>
      );
    case "br":
      return <br key={key} />;
    case "hr":
      return <hr key={key} className="my-3 border-border" />;
    case "pre":
      return (
        <pre key={key} className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
          {children()}
        </pre>
      );
    case "code":
      return (
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {children()}
        </code>
      );
    case "blockquote":
      return (
        <blockquote key={key} className="border-l-2 border-border pl-3 text-muted-foreground">
          {children()}
        </blockquote>
      );
    case "ul":
      return (
        <ul key={key} className="list-disc space-y-1 pl-5">
          {children()}
        </ul>
      );
    case "ol":
      return (
        <ol key={key} start={numericAttribute(element, "start")} className="list-decimal space-y-1 pl-5">
          {children()}
        </ol>
      );
    case "li":
      return <li key={key}>{children()}</li>;
    case "table":
      return (
        <div key={key} className="overflow-x-auto">
          <table className="w-max min-w-full border-collapse border border-border">{children()}</table>
        </div>
      );
    case "thead":
      return (
        <thead key={key} className="bg-surface-recessed">
          {children()}
        </thead>
      );
    case "tbody":
      return <tbody key={key}>{children()}</tbody>;
    case "tfoot":
      return <tfoot key={key}>{children()}</tfoot>;
    case "tr":
      return <tr key={key}>{children()}</tr>;
    case "th":
      return (
        <th
          key={key}
          colSpan={numericAttribute(element, "colspan")}
          rowSpan={numericAttribute(element, "rowspan")}
          className={cn("border border-border px-2 py-1 font-medium", tableCellAlign(element))}
        >
          {children()}
        </th>
      );
    case "td":
      return (
        <td
          key={key}
          colSpan={numericAttribute(element, "colspan")}
          rowSpan={numericAttribute(element, "rowspan")}
          className={cn("border border-border px-2 py-1", tableCellAlign(element))}
        >
          {children()}
        </td>
      );
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Math.min(Number(tag[1]), 4);
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4";
      return (
        <Tag key={key} className={HEADING_CLASSES[level - 1]}>
          {children()}
        </Tag>
      );
    }
    case "strong":
    case "b":
      return <strong key={key}>{children()}</strong>;
    case "em":
    case "i":
      return <em key={key}>{children()}</em>;
    case "del":
    case "s":
    case "strike":
      return <del key={key}>{children()}</del>;
    case "u":
    case "ins":
      return <u key={key}>{children()}</u>;
    case "sup":
      return <sup key={key}>{children()}</sup>;
    case "sub":
      return <sub key={key}>{children()}</sub>;
    case "kbd":
      return (
        <kbd key={key} className="rounded border border-border bg-muted px-1 font-mono text-[0.85em]">
          {children()}
        </kbd>
      );
    case "mark":
      return (
        <mark key={key} className="rounded bg-yellow-500/20 px-0.5">
          {children()}
        </mark>
      );
    case "details":
      return (
        <details key={key} open={element.hasAttribute("open")} className="rounded-md">
          {children()}
        </details>
      );
    case "summary":
      return (
        <summary key={key} className="cursor-pointer font-medium">
          {children()}
        </summary>
      );
    case "input": {
      // GitHub task-list checkboxes; every other input is dropped.
      if (element.getAttribute("type") !== "checkbox") return null;
      return <input key={key} type="checkbox" disabled checked={element.hasAttribute("checked")} className="mr-1 align-middle" />;
    }
    case "dl":
      return <dl key={key}>{children()}</dl>;
    case "dt":
      return (
        <dt key={key} className="font-medium">
          {children()}
        </dt>
      );
    case "dd":
      return (
        <dd key={key} className="pl-4">
          {children()}
        </dd>
      );
    // Unwrap: keep the children, drop the wrapper. Covers div, span, g-emoji,
    // picture, font, and GitHub's other inert wrappers.
    default:
      return children();
  }
}

export function GithubHtml({ html, className }: { html: string; className?: string }) {
  const nodes = useMemo(() => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return [...doc.body.childNodes].map((node, index) => renderNode(node, index));
  }, [html]);
  return <div className={cn("space-y-3", className)}>{nodes}</div>;
}

/**
 * A GitHub body: prefers the API-rendered HTML so inline HTML (tables,
 * relative-time, details) matches github.com; falls back to the local
 * Markdown renderer when only `body` is available (issues, stale responses).
 */
export function GithubBody({ body, bodyHtml, className }: { body: string; bodyHtml?: string | null; className?: string }) {
  if (bodyHtml) return <GithubHtml html={bodyHtml} className={className} />;
  return <Markdown content={body} className={className} />;
}
