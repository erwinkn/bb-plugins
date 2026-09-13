import type { Status } from "../lib/status";

/**
 * Status colors follow the theme plugin's palette roles with BB's own tokens
 * as fallbacks: attention amber, unread file blue, working done green, draft
 * agent purple. Done stays subtle. Each status also has its own shape, so
 * color never carries the status alone.
 */
export const STATUS_COLOR_CLASS: Record<Status, string> = {
  attention: "text-[var(--bbp-attention,var(--warning-text))]",
  unread: "text-[var(--bbp-file,var(--timeline-accent))]",
  working: "text-[var(--bbp-done,var(--success))]",
  draft: "text-[var(--bbp-agent,var(--pr-merged))]",
  done: "text-[var(--subtle-foreground)]",
};

export function StatusIcon({
  status,
  className = "",
  size = "default",
}: {
  status: Status;
  className?: string;
  size?: "small" | "default";
}) {
  return (
    <svg
      aria-hidden="true"
      data-status-icon={status}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${size === "small" ? "size-3.5" : "size-4"} shrink-0 ${STATUS_COLOR_CLASS[status]} ${status === "working" ? "motion-safe:animate-spin" : ""} ${className}`}
    >
      {status === "attention" && (
        <>
          <circle cx="10" cy="10" r="7.5" />
          <path d="M10 6v4m0 3h.01" />
        </>
      )}
      {status === "unread" && (
        <>
          <path d="M4 13.5h12l-1.5-3V7a4.5 4.5 0 0 0-9 0v3.5zM8 16a2.2 2.2 0 0 0 4 0" />
        </>
      )}
      {status === "working" && (
        <path d="M10 2v2m0 12v2M2 10h2m12 0h2M4.34 4.34l1.42 1.42m8.48 8.48 1.42 1.42M4.34 15.66l1.42-1.42m8.48-8.48 1.42-1.42" />
      )}
      {status === "draft" && (
        <circle cx="10" cy="10" r="7.5" strokeDasharray="3 3" />
      )}
      {status === "done" && (
        <>
          <circle cx="10" cy="10" r="7.5" />
          <path d="m6.5 10 2.3 2.3 4.7-4.6" />
        </>
      )}
    </svg>
  );
}
